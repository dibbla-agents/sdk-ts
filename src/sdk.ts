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
import {
  registerHandlers,
  startMessageListener,
  handleListFunctions,
  startupEventState,
  startupBroadcastEventState,
  EventState,
  HandlerContext,
} from './internal/handlers/handlers';
import { announceJobs, registerJobHandlers } from './internal/handlers/jobs';
import { CapabilityRegistry, handleListCapabilityProviders, registerCapabilityHandlers } from './internal/handlers/capability';
import { CapabilityProvider } from './providers';
import { WorkerFunction, GlobalState, FunctionCache } from './function';
import { JobHandler } from './jobs/types';
import { functionKey } from './types/keys';

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
  private handlerContext: HandlerContext | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private functions: Map<string, WorkerFunction<any, any>> = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pendingFunctions: WorkerFunction<any, any>[] = [];
  private jobs: JobHandler[] = [];
  private capabilities = new CapabilityRegistry();
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.functions.set(functionKey(this.config.serverName, fn.name, fn.version), fn as any);
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
   * Register a capability provider (see toolSearchProvider, memoryProvider).
   * Must be called before start(). Throws for definitions the workflow server
   * would reject, so a misconfigured provider fails at startup instead of
   * never appearing.
   */
  registerCapabilityProvider(provider: CapabilityProvider): void {
    if (this.started) throw new Error('registerCapabilityProvider must be called before start()');
    this.capabilities.add(provider);
  }

  /**
   * Register a job the workflow server can trigger. Must be called before
   * start(); jobs are announced on connect and after every reconnect.
   */
  registerJob(job: JobHandler): void {
    if (this.started) throw new Error('registerJob must be called before start()');
    if (!job.id) throw new Error('job id must not be empty');
    if (this.jobs.some((j) => j.id === job.id)) throw new Error(`job ${job.id} is already registered`);
    this.jobs.push(job);
  }

  /**
   * Start the server and connect to the workflow server.
   * Resolves when stop() is called; rejects if no connection can be made
   * within 30 seconds.
   */
  async start(): Promise<void> {
    log.info(`Starting server with name: ${this.config.serverName}`);

    this.initializeGlobalState();

    // Wait for the connection before sending any registrations
    log.info('Waiting for gRPC connection...');
    try {
      await this.communicator!.waitForConnection(30_000);
    } catch (err) {
      await this.communicator!.close();
      throw new Error(`failed to establish connection: ${errorMessage(err)}`);
    }

    // Everything announced below is announced again on every reconnect.
    this.communicator!.setOnReconnect(() => {
      this.onReconnect().catch((err) => log.error(`Re-registration failed: ${errorMessage(err)}`));
    });

    this.registerPendingFunctions();
    this.handlerContext = this.createHandlerContext();

    await this.registerServer();
    await this.sendStartupBroadcast();
    await this.registerJobs();

    registerHandlers(this.handlerContext);
    registerCapabilityHandlers(this.handlerContext);
    registerJobHandlers({ ...this.handlerContext, jobs: this.jobs });
    startMessageListener(this.handlerContext);
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
    return this.globalState();
  }

  // Private methods

  private globalState(): GlobalState {
    return {
      serverName: this.config.serverName,
      cache: this.cacheClient,
      store: this.storeClient,
      oauth: this.oauthClient,
      rpc: this.rpcClient,
    };
  }

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

    this.cacheClient = new GrpcCacheClient(this.communicator, this.config.serverName);
    this.storeClient = new GrpcStoreClient(this.communicator, this.config.serverName);
    this.oauthClient = new GrpcOAuthClient(this.communicator, this.config.serverName);
    this.rpcClient = new RpcClient(this.communicator, this.config.serverName);

    this.dispatcher = new Dispatcher(this.config.handlersConcurrency, this.config.incomingEventsBuffer);
    this.dispatcher.start();

    log.info('Initialized global state (gRPC mode)');
  }

  private createHandlerContext(): HandlerContext {
    return {
      serverName: this.config.serverName,
      communicator: this.communicator!,
      dispatcher: this.dispatcher!,
      functions: this.functions,
      cacheClient: this.cacheClient!,
      storeClient: this.storeClient!,
      oauthClient: this.oauthClient!,
      rpcClient: this.rpcClient!,
      globalState: this.globalState(),
      capabilities: this.capabilities,
    };
  }

  /**
   * Called when the connection is re-established after a disconnect: the
   * server has forgotten this worker, so everything is announced again.
   */
  private async onReconnect(): Promise<void> {
    log.info('Connection re-established, re-registering with workflow server...');
    await this.registerServer();
    await this.sendStartupBroadcast();
    await this.registerJobs();
    log.info('Re-registration complete');
  }

  private registerPendingFunctions(): void {
    for (const fn of this.pendingFunctions) {
      this.setupFunction(fn);
      this.functions.set(functionKey(this.config.serverName, fn.name, fn.version), fn);
    }
    this.pendingFunctions = [];
    log.info(`Registered ${this.functions.size} functions`);
  }

  private setupFunction(fn: WorkerFunction): void {
    fn.setServer(this.config.serverName);

    if (this.cacheClient) {
      const cache = this.cacheClient;
      const adapter: FunctionCache = {
        get: (key) => cache.get(key),
        set: (key, value) => cache.set(key, value),
        setWithTTL: (key, value, ttlMs) => cache.setWithTTL(key, value, ttlMs),
      };
      fn.setCache(adapter);
    }
  }

  /** What the worker announces on every (re)connect, in sdk-go's order. */
  private async announce(state: EventState): Promise<void> {
    await handleListFunctions(this.handlerContext!, state);
    await handleListCapabilityProviders(this.handlerContext!, state);
  }

  private async registerServer(): Promise<void> {
    await this.announce(startupEventState(this.config.serverName));
    log.info(`Server '${this.config.serverName}' registered with workflow server`);
  }

  private async registerJobs(): Promise<void> {
    await announceJobs({ serverName: this.config.serverName, communicator: this.communicator!, jobs: this.jobs });
  }

  private async sendStartupBroadcast(): Promise<void> {
    await this.announce(startupBroadcastEventState(this.config.serverName));
    log.info('Startup function list broadcast sent');
  }
}

/**
 * Create a new SDK server instance with the provided options.
 */
export function create(options: ServerOptions = {}): Server {
  return new Server(options);
}
