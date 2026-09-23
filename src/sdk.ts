import * as dotenv from 'dotenv';
import { ServerConfig, ServerOptions, mergeConfig, resolveTLS } from './config';
import { GrpcCommunicator } from './internal/grpc/communicator';
import { detectFileTokenProvider, TokenProvider } from './internal/grpc/token-provider';
import { log, errorMessage } from './internal/log';
import { Dispatcher } from './internal/dispatcher/dispatcher';
import { GrpcCacheClient } from './internal/cache/cache-client';
import { GrpcStoreClient } from './internal/store/store-client';
import { GrpcOAuthClient } from './internal/oauth/oauth-client';
import { RpcClient } from './internal/rpc/rpc-client';
import { registerHandlers, startMessageListener, HandlerContext } from './internal/handlers/handlers';
import { WorkerFunction, GlobalState, FunctionCache } from './function';
import { functionKey } from './types/keys';
import { Events, EventMessage } from './types/events';

// Load environment variables
dotenv.config();

/**
 * Server represents the SDK server instance.
 * This is the main entry point for using the Dibbla Agents SDK.
 */
export class Server {
  private config: ServerConfig;
  private communicator: GrpcCommunicator | null = null;
  private dispatcher: Dispatcher | null = null;
  private cacheClient: GrpcCacheClient | null = null;
  private storeClient: GrpcStoreClient | null = null;
  private oauthClient: GrpcOAuthClient | null = null;
  private rpcClient: RpcClient | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private functions: Map<string, WorkerFunction<any, any>> = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pendingFunctions: WorkerFunction<any, any>[] = [];
  private started = false;
  private resolveStopped: (() => void) | null = null;

  constructor(options: ServerOptions = {}) {
    this.config = mergeConfig(options);
  }

  /**
   * Register a function with the server.
   * The function will be available for invocation once the server starts.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerFunction<TInput = any, TOutput = any>(fn: WorkerFunction<TInput, TOutput>): void {
    if (this.started) {
      // If already started, register immediately
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.setupFunction(fn as any);
      const key = functionKey(this.config.serverName, fn.name, fn.version);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.functions.set(key, fn as any);
      log.info(`Registered function: ${fn.name}:${fn.version}`);
    } else {
      // Queue for registration on start
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.pendingFunctions.push(fn as any);
    }
  }

  /**
   * Register multiple functions with the server.
   * Convenience method for bulk registration of function definitions.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerFunctions(fns: WorkerFunction<any, any>[]): void {
    for (const fn of fns) {
      this.registerFunction(fn);
    }
  }

  /**
   * Start the server and connect to the workflow server.
   * This method blocks until the server is shut down.
   */
  async start(): Promise<void> {
    log.info(`Starting server with name: ${this.config.serverName}`);

    // Initialize global state and services
    this.initializeGlobalState();

    // Wait for the connection before sending any registrations
    log.info('Waiting for gRPC connection...');
    try {
      await this.communicator!.waitForConnection(30_000);
    } catch (err) {
      await this.communicator!.close();
      throw new Error(`failed to establish connection: ${errorMessage(err)}`);
    }

    // Everything registered below is registered again on every reconnect.
    this.communicator!.setOnReconnect(() => {
      this.onReconnect().catch((err) => log.error(`Re-registration failed: ${errorMessage(err)}`));
    });

    // Register pending functions
    this.registerPendingFunctions();

    // Register the server with the workflow server
    await this.registerServer();

    // Send startup broadcast
    await this.sendStartupBroadcast();

    // Activate handlers
    this.activateHandlers();

    log.info('Stream listeners activated, server running...');
    this.started = true;

    // Run until stop()
    await new Promise<void>((resolve) => (this.resolveStopped = resolve));
  }

  /**
   * Disconnects from the workflow server and makes start() return.
   */
  async stop(): Promise<void> {
    await this.communicator?.close();
    await this.dispatcher?.stop();
    this.resolveStopped?.();
  }

  /**
   * Get the current configuration.
   */
  getConfig(): ServerConfig {
    return { ...this.config };
  }

  /**
   * Get the global state for advanced use cases.
   */
  getGlobalState(): GlobalState | null {
    if (!this.communicator) return null;

    return {
      serverName: this.config.serverName,
      cache: this.cacheClient,
      store: this.storeClient,
      oauth: this.oauthClient,
      rpc: this.rpcClient,
    };
  }

  // Private methods

  private initializeGlobalState(): void {
    const useTLS = resolveTLS(this.config);

    // Workload identity (DIB-202): with no explicit API token, use the
    // projected identity token when one is present. It is re-read at every
    // (re)connect, so kubelet rotation needs no coordination. An explicit
    // token always wins, so local development is unchanged.
    let tokenProvider: TokenProvider | undefined;
    if (!this.config.serverApiToken) {
      const fileProvider = detectFileTokenProvider(this.config.identityTokenFile);
      if (fileProvider) {
        log.info(`🔐 Using workload identity credential (${fileProvider.source()})`);
        tokenProvider = fileProvider;
      }
    }

    // Create gRPC communicator
    this.communicator = new GrpcCommunicator({
      serverAddress: this.config.grpcServerAddress,
      serverName: this.config.serverName,
      apiToken: this.config.serverApiToken,
      tokenProvider,
      orgId: this.config.orgId,
      useTLS,
      insecureSkipVerify: this.config.tlsInsecureSkipVerify,
      incomingBuffer: this.config.incomingEventsBuffer,
      reconnectIntervalSec: this.config.grpcReconnectIntervalSec,
      healthcheckIntervalSec: this.config.grpcHealthcheckIntervalSec,
      pingIntervalSec: this.config.pingIntervalSec,
      keepaliveTimeSec: this.config.grpcKeepaliveTimeSec,
      keepaliveTimeoutSec: this.config.grpcKeepaliveTimeoutSec,
    });

    // Connect in the background; start() waits for the first connection.
    this.communicator.connect();

    // Initialize service clients
    this.cacheClient = new GrpcCacheClient(this.communicator, this.config.serverName);
    this.storeClient = new GrpcStoreClient(this.communicator, this.config.serverName);
    this.oauthClient = new GrpcOAuthClient(this.communicator, this.config.serverName);
    this.rpcClient = new RpcClient(this.communicator, this.config.serverName);

    // Initialize dispatcher
    this.dispatcher = new Dispatcher(this.config.handlersConcurrency);
    this.dispatcher.start();

    log.info('Initialized global state (gRPC mode)');
  }

  /**
   * Called when the connection is re-established after a disconnect: the
   * server has forgotten this worker, so everything is registered again.
   */
  private async onReconnect(): Promise<void> {
    log.info('Connection re-established, re-registering with workflow server...');
    await this.registerServer();
    await this.sendStartupBroadcast();
    log.info('Re-registration complete');
  }

  private registerPendingFunctions(): void {
    for (const fn of this.pendingFunctions) {
      this.setupFunction(fn);
      const key = functionKey(this.config.serverName, fn.name, fn.version);
      this.functions.set(key, fn);
    }

    this.pendingFunctions = [];
    log.info(`Registered ${this.functions.size} functions`);
  }

  private setupFunction(fn: WorkerFunction): void {
    // Set server name
    fn.setServer(this.config.serverName);

    // Set cache if available
    if (this.cacheClient) {
      const cacheAdapter: FunctionCache = {
        get: async (key: bigint) => this.cacheClient!.get(key),
        set: async (key: bigint, value: Buffer) => this.cacheClient!.set(key, value),
        setWithTTL: async (key: bigint, value: Buffer, ttlMs: number) => 
          this.cacheClient!.setWithTTL(key, value, ttlMs),
      };
      fn.setCache(cacheAdapter);
    }
  }

  private async registerServer(): Promise<void> {
    if (!this.communicator || !this.dispatcher) return;

    // Create a minimal event state for registration
    const eventState = {
      function: '',
      version: '',
      node: '',
      workflow: '',
      run: '',
      server: this.config.serverName,
      correlationId: 'startup',
    };

    await this.handleListFunctions(eventState);
    log.info(`Server '${this.config.serverName}' registered with workflow server`);
  }

  private async sendStartupBroadcast(): Promise<void> {
    if (!this.communicator) return;

    const eventState = {
      function: 'startup',
      version: '1.0',
      node: 'startup',
      workflow: 'startup',
      run: 'startup',
      server: this.config.serverName,
      correlationId: 'startup',
    };

    await this.handleListFunctions(eventState);
    log.info('Startup function list broadcast sent');
  }

  private async handleListFunctions(eventState: {
    function: string;
    version: string;
    node: string;
    workflow: string;
    run: string;
    server: string;
    correlationId: string;
  }): Promise<void> {
    if (!this.communicator) return;

    const definitions = Array.from(this.functions.values()).map(fn => fn.getDefinition());
    const payload = Buffer.from(JSON.stringify(definitions));

    const event: EventMessage = {
      function: eventState.function,
      node: eventState.node,
      workflow: eventState.workflow,
      version: eventState.version,
      server: this.config.serverName,
      event: Events.ResponseListFunctions,
      text: 'List of functions',
      run: eventState.run,
      meta: null,
      payload,
      correlationId: eventState.correlationId,
    };

    try {
      await this.communicator.sendEvent(event);
    } catch (err) {
      log.error(`Failed to send list functions: ${errorMessage(err)}`);
    }
  }

  private activateHandlers(): void {
    if (!this.communicator || !this.dispatcher || !this.cacheClient || 
        !this.storeClient || !this.oauthClient || !this.rpcClient) {
      throw new Error('Services not initialized');
    }

    const ctx: HandlerContext = {
      serverName: this.config.serverName,
      communicator: this.communicator,
      dispatcher: this.dispatcher,
      functions: this.functions,
      cacheClient: this.cacheClient,
      storeClient: this.storeClient,
      oauthClient: this.oauthClient,
      rpcClient: this.rpcClient,
    };

    registerHandlers(ctx);
    startMessageListener(ctx);
  }
}

/**
 * Create a new SDK server instance with the provided options.
 */
export function create(options: ServerOptions = {}): Server {
  return new Server(options);
}

