import * as grpc from '@grpc/grpc-js';
import { EventMessage, Events } from '../../types/events';
import { log, errorMessage } from '../log';
import { GrpcEventMessage, fromGrpc, toGrpc } from './envelope';
import { eventService } from './proto';
import { DEFAULT_IDENTITY_TOKEN_PATH, TokenProvider } from './token-provider';

/**
 * The slowest retry cadence, and the holding pattern for failures retrying
 * cannot fix (a rejected credential): the worker keeps trying at this pace so
 * it heals once the cause is fixed, without hammering the server meanwhile.
 */
export const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;

/** A connection that stayed up this long earns a backoff reset. */
export const DEFAULT_HEALTHY_RESET_AFTER_MS = 60_000;

/**
 * HTTP/2 keepalive defaults. Five minutes is the fastest a gRPC server's
 * default enforcement tolerates on a direct connection; faster pings earn a
 * GOAWAY "too_many_pings". Behind a proxy that answers pings itself (e.g.
 * Traefik) a shorter interval is safe and detects dead connections sooner.
 */
export const DEFAULT_KEEPALIVE_TIME_MS = 5 * 60_000;
export const DEFAULT_KEEPALIVE_TIMEOUT_MS = 20_000;

export interface GrpcCommunicatorOptions {
  serverAddress: string;
  serverName: string;
  /** A fixed credential. Ignored when tokenProvider is set. */
  apiToken?: string;
  /** Consulted at every stream open, overriding apiToken (workload identity). */
  tokenProvider?: TokenProvider;
  /** Sent as x-org-id to pin registration to one organization. */
  orgId?: string;
  /** Defaults to shouldUseTLS(serverAddress). */
  useTLS?: boolean;
  /** Skip server certificate verification. Insecure; only with TLS. */
  insecureSkipVerify?: boolean;
  /** Messages kept while no message handler is attached. */
  incomingBuffer?: number;
  /** Initial retry interval; doubles per failure up to the maximum backoff. */
  reconnectIntervalSec?: number;
  healthcheckIntervalSec?: number;
  /** 0 disables pings. */
  pingIntervalSec?: number;
  /** HTTP/2 keepalive interval and ack timeout; 0 means the defaults. */
  keepaliveTimeSec?: number;
  keepaliveTimeoutSec?: number;
  /** Tuning, mostly for tests. */
  maxBackoffMs?: number;
  healthyResetAfterMs?: number;
}

/**
 * Determine if TLS should be used based on the server address.
 * localhost/127.0.0.1/[::1] = no TLS (development)
 * Everything else = TLS (production)
 */
export function shouldUseTLS(address: string): boolean {
  return !(address.startsWith('localhost:') || address.startsWith('127.0.0.1:') || address.startsWith('[::1]:'));
}

export class NotConnectedError extends Error {
  constructor() {
    super('not connected to workflow server');
    this.name = 'NotConnectedError';
  }
}

/** Failures that reconnecting with the same credential cannot fix. */
export function isNonRetryable(err: unknown): boolean {
  const code = (err as { code?: unknown } | undefined)?.code;
  return code === grpc.status.UNAUTHENTICATED || code === grpc.status.PERMISSION_DENIED;
}

/** A random duration in [d/2, d], spreading a fleet's reconnects apart. */
export function jitter(ms: number): number {
  if (ms <= 1) return ms;
  const half = ms / 2;
  return half + Math.random() * half;
}

type EventStream = grpc.ClientDuplexStream<GrpcEventMessage, GrpcEventMessage>;

/** One live connection: its channel, its stream, and how it died. */
class Connection {
  private cause: Error | undefined;
  private settle!: (cause: Error | undefined) => void;
  readonly dead: Promise<Error | undefined>;
  isDead = false;
  pingTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly client: grpc.Client,
    readonly stream: EventStream,
  ) {
    this.dead = new Promise((resolve) => (this.settle = resolve));
  }

  /** Marks the connection dead. The first cause wins. */
  kill(cause?: Error): void {
    if (this.isDead) return;
    this.isDead = true;
    this.cause = cause;
    this.settle(cause);
  }

  teardown(): void {
    this.kill(this.cause);
    if (this.pingTimer) clearInterval(this.pingTimer);
    try {
      this.stream.cancel();
    } catch {
      // already gone
    }
    try {
      this.client.close();
    } catch {
      // already gone
    }
  }
}

function write(stream: EventStream, message: GrpcEventMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(message, (err: Error | null | undefined) => (err ? reject(err) : resolve()));
  });
}

/**
 * The bidirectional event stream to the workflow server.
 *
 * One supervisor loop owns every connect and teardown decision, so there is
 * never more than one live connection and nothing accumulates across
 * reconnects. Each connection's ping timer and stream listeners belong to that
 * connection and die with it.
 */
export class GrpcCommunicator {
  private readonly serverAddress: string;
  private readonly serverName: string;
  private readonly apiToken: string;
  private readonly tokenProvider: TokenProvider | undefined;
  private readonly orgId: string;
  private readonly useTLS: boolean;
  private readonly insecureSkipVerify: boolean;
  private readonly incomingBuffer: number;
  private readonly reconnectIntervalMs: number;
  private readonly healthcheckIntervalMs: number;
  private readonly pingIntervalMs: number;
  private readonly keepaliveTimeMs: number;
  private readonly keepaliveTimeoutMs: number;
  private readonly maxBackoffMs: number;
  private readonly healthyResetAfterMs: number;

  private conn: Connection | null = null;
  /** A connection attempt in progress, so close() can abort it. */
  private connecting: Connection | null = null;
  private supervisor: Promise<void> | null = null;
  private closed = false;
  private wakeSleeper: (() => void) | null = null;
  private lastToken = '';
  private everConnected = false;
  private resolveFirstConnection!: () => void;
  private readonly firstConnection: Promise<void>;

  private messageHandler: ((message: EventMessage) => void) | null = null;
  private pending: EventMessage[] = [];
  private reconnectHandler: (() => void) | null = null;

  constructor(options: GrpcCommunicatorOptions) {
    this.serverAddress = options.serverAddress;
    this.serverName = options.serverName;
    this.apiToken = options.apiToken ?? '';
    this.tokenProvider = options.tokenProvider;
    this.orgId = options.orgId ?? '';
    this.useTLS = options.useTLS ?? shouldUseTLS(options.serverAddress);
    this.insecureSkipVerify = options.insecureSkipVerify ?? false;
    this.incomingBuffer = options.incomingBuffer && options.incomingBuffer > 0 ? options.incomingBuffer : 100;
    this.reconnectIntervalMs = (options.reconnectIntervalSec && options.reconnectIntervalSec > 0 ? options.reconnectIntervalSec : 5) * 1000;
    this.healthcheckIntervalMs = (options.healthcheckIntervalSec && options.healthcheckIntervalSec > 0 ? options.healthcheckIntervalSec : 30) * 1000;
    this.pingIntervalMs = Math.max(0, options.pingIntervalSec ?? 30) * 1000;
    this.keepaliveTimeMs = options.keepaliveTimeSec && options.keepaliveTimeSec > 0 ? options.keepaliveTimeSec * 1000 : DEFAULT_KEEPALIVE_TIME_MS;
    this.keepaliveTimeoutMs =
      options.keepaliveTimeoutSec && options.keepaliveTimeoutSec > 0 ? options.keepaliveTimeoutSec * 1000 : DEFAULT_KEEPALIVE_TIMEOUT_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.healthyResetAfterMs = options.healthyResetAfterMs ?? DEFAULT_HEALTHY_RESET_AFTER_MS;
    this.firstConnection = new Promise((resolve) => (this.resolveFirstConnection = resolve));
  }

  /** Starts the connection supervisor in the background. */
  connect(): void {
    if (this.closed) throw new Error('communicator has been closed');
    if (this.supervisor) return;
    this.supervisor = this.run();
    log.info(
      `Started gRPC connection attempts to ${this.serverAddress} (retrying with backoff, ${this.reconnectIntervalMs / 1000}s initial interval)`,
    );
  }

  /** Resolves on the first successful connection; rejects after timeoutMs. */
  waitForConnection(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`connection timeout after ${timeoutMs}ms`)), timeoutMs);
      this.firstConnection.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  isConnected(): boolean {
    return this.conn !== null && !this.conn.isDead;
  }

  /**
   * Receives every incoming message. Messages that arrive before a handler is
   * attached are kept (up to the incoming buffer) and delivered on attach.
   */
  setMessageHandler(handler: (message: EventMessage) => void): void {
    this.messageHandler = handler;
    const pending = this.pending;
    this.pending = [];
    for (const message of pending) handler(message);
  }

  /** Called after each reconnect (not the first connect), to register again. */
  setOnReconnect(handler: () => void): void {
    this.reconnectHandler = handler;
  }

  async sendEvent(event: EventMessage): Promise<void> {
    const conn = this.conn;
    if (!conn || conn.isDead) throw new NotConnectedError();
    try {
      await write(conn.stream, toGrpc(event));
    } catch (err) {
      log.warn(`Failed to send event via gRPC: ${errorMessage(err)}`);
      conn.kill(new Error(`send failed: ${errorMessage(err)}`));
      throw new Error(`failed to send event: ${errorMessage(err)}`);
    }
    if (event.event !== Events.Ping) log.debug(`Sent event via gRPC: ${event.event}`);
  }

  /** Stops reconnecting and tears down the current connection. */
  async close(): Promise<void> {
    this.closed = true;
    this.conn?.kill();
    this.connecting?.teardown();
    this.wakeSleeper?.();
    await this.supervisor;
    log.info('gRPC client closed');
  }

  // --- supervisor ------------------------------------------------------------

  private async run(): Promise<void> {
    const initial = this.reconnectIntervalMs;
    let backoff = initial;

    while (!this.closed) {
      let died = false;
      let cause: Error | undefined;

      // Nothing a connection attempt throws may end the supervisor: a worker
      // that stops reconnecting is worse than one that logs and retries.
      const conn = await this.attemptConnection().catch((err) => {
        log.error(`Connection attempt failed unexpectedly: ${errorMessage(err)}`);
        return null;
      });
      if (conn) {
        const connectedAt = Date.now();
        cause = await this.supervise(conn);
        conn.teardown();
        if (this.conn === conn) this.conn = null;
        died = true;
        if (this.closed) return;

        // A connection that stayed healthy earns a reset. One that died at
        // once (a rejected token) must not, or connect-then-die would spin.
        if (Date.now() - connectedAt >= this.healthyResetAfterMs) backoff = initial;

        if (isNonRetryable(cause)) {
          if (await this.credentialRotated()) {
            // The rejected credential has been replaced on disk (kubelet
            // rotated the projected token): the next attempt can succeed.
            log.info('🔁 Credential rotated since last attempt; retrying on normal cadence');
            backoff = initial;
          } else {
            backoff = this.maxBackoffMs;
          }
        }
      }

      // Wait on every path, including connected-then-died. Jitter spreads a
      // fleet's reconnects after a server restart.
      const delay = jitter(backoff);
      if (died) {
        const seconds = `${(delay / 1000).toFixed(1)}s`;
        if (isNonRetryable(cause)) {
          const detail = (cause as grpc.ServiceError).details ?? errorMessage(cause);
          if ((cause as grpc.ServiceError).code === grpc.status.UNAUTHENTICATED) {
            log.error(`❌ Authentication failed: Invalid or expired API token. Retrying in ${seconds}. Error: ${detail}`);
          } else {
            log.error(`❌ Non-retryable error on stream: ${detail}. Retrying in ${seconds}`);
          }
        } else {
          log.warn(`Connection lost (${cause ? errorMessage(cause) : 'closed'}), reconnecting in ${seconds}`);
        }
      }

      await this.sleep(delay);
      backoff = Math.min(backoff * 2, this.maxBackoffMs);
    }
  }

  /** Resolves with the cause of the connection's death. */
  private async supervise(conn: Connection): Promise<Error | undefined> {
    const health = setInterval(() => {
      const state = conn.client.getChannel().getConnectivityState(false);
      if (state === grpc.connectivityState.TRANSIENT_FAILURE || state === grpc.connectivityState.SHUTDOWN) {
        conn.kill(new Error(`connection unhealthy (state: ${grpc.connectivityState[state]})`));
      }
    }, this.healthcheckIntervalMs);
    try {
      return await conn.dead;
    } finally {
      clearInterval(health);
    }
  }

  private async credentialRotated(): Promise<boolean> {
    if (!this.tokenProvider) return false;
    try {
      const token = await this.tokenProvider.token();
      return token !== '' && token !== this.lastToken;
    } catch {
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        self.wakeSleeper = null;
        resolve();
      }
      this.wakeSleeper = done;
    });
  }

  private async resolveToken(): Promise<string> {
    if (!this.tokenProvider) return this.apiToken;
    try {
      return await this.tokenProvider.token();
    } catch (err) {
      log.warn(`⚠️  Credential read failed (${this.tokenProvider.source()}): ${errorMessage(err)} — attempting without it`);
      return '';
    }
  }

  private credentials(): grpc.ChannelCredentials {
    if (!this.useTLS) {
      log.info(`Connecting without TLS to ${this.serverAddress}`);
      return grpc.credentials.createInsecure();
    }
    if (this.insecureSkipVerify) {
      log.warn(`Connecting with TLS to ${this.serverAddress} (certificate verification DISABLED)`);
      return grpc.credentials.createSsl(null, null, null, {
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
      });
    }
    log.info(`Connecting with TLS to ${this.serverAddress}`);
    return grpc.credentials.createSsl();
  }

  private channelOptions(): grpc.ChannelOptions {
    return {
      'grpc.keepalive_time_ms': this.keepaliveTimeMs,
      'grpc.keepalive_timeout_ms': this.keepaliveTimeoutMs,
      // The worker always holds its Events stream while connected, and
      // default server enforcement rejects pings without one.
      'grpc.keepalive_permit_without_calls': 0,
      // No DNS service-config lookup: unused, and the TXT query can stall
      // for ~20s on resolvers that drop it (split-DNS, Tailscale).
      'grpc.service_config_disable_resolution': 1,
    };
  }

  private async attemptConnection(): Promise<Connection | null> {
    log.info(`Attempting to connect to gRPC server at ${this.serverAddress}...`);

    // Resolved fresh on every attempt so a rotated identity token is used.
    const token = await this.resolveToken();
    this.lastToken = token;
    if (!token) {
      log.warn(
        `⚠️  Warning: No credential available. Set SERVER_API_TOKEN, or run on the Dibbla platform where a workload identity token is provided (${DEFAULT_IDENTITY_TOKEN_PATH}).`,
      );
    }
    if (this.closed) return null;

    // Like grpc-go's lazy client: the stream opens at once and the first
    // write waits for the transport, failing fast (UNAVAILABLE) if the
    // server cannot be reached.
    const Service = eventService();
    const client = new Service(this.serverAddress, this.credentials(), this.channelOptions());

    const metadata = new grpc.Metadata();
    if (token) metadata.set('authorization', `Bearer ${token}`);
    if (this.orgId) metadata.set('x-org-id', this.orgId);

    const stream = (client as unknown as { Events(md: grpc.Metadata): EventStream }).Events(metadata);
    const conn = new Connection(client, stream);
    stream.on('data', (message: GrpcEventMessage) => this.receive(conn, message));
    stream.on('error', (err: grpc.ServiceError) => {
      if (!conn.isDead) log.warn(`gRPC stream error: ${err.message}`);
      conn.kill(err);
    });
    stream.on('end', () => {
      if (!conn.isDead) log.warn('gRPC stream closed by server');
      conn.kill(new Error('stream closed by server'));
    });

    this.connecting = conn;
    try {
      await write(stream, {
        server: this.serverName,
        event: Events.ClientRegistration,
        text: 'Client registration',
        correlation_id: '',
      });
    } catch (err) {
      conn.kill(err as Error);
      const cause = await conn.dead;
      if (!this.closed && isNonRetryable(cause)) {
        // Rejected (say, Unauthenticated) while the registration was in
        // flight: hand it to the supervisor to classify, not retry fast.
        log.error(`Stream rejected during registration: ${errorMessage(cause)}`);
        return conn;
      }
      conn.teardown();
      if (!this.closed) log.error(`Failed to connect to gRPC server at ${this.serverAddress}: ${errorMessage(cause)}`);
      return null;
    } finally {
      this.connecting = null;
    }
    if (this.closed) {
      conn.teardown();
      return null;
    }

    this.conn = conn;
    if (this.pingIntervalMs > 0) {
      conn.pingTimer = setInterval(() => this.sendPing(), this.pingIntervalMs);
    }

    log.info(`✅ gRPC client successfully connected to workflow server at ${this.serverAddress}`);

    const isReconnect = this.everConnected;
    this.everConnected = true;
    this.resolveFirstConnection();
    if (isReconnect && this.reconnectHandler) {
      const handler = this.reconnectHandler;
      setImmediate(() => {
        try {
          handler();
        } catch (err) {
          log.error(`Reconnect handler failed: ${errorMessage(err)}`);
        }
      });
    }
    return conn;
  }

  private receive(conn: Connection, raw: GrpcEventMessage): void {
    // A torn-down connection is always dead. Before it is marked connected
    // (registration still in flight) messages are kept, as gRPC-Go would.
    if (conn.isDead) return;
    let message: EventMessage;
    try {
      message = fromGrpc(raw);
    } catch (err) {
      log.warn(`Failed to convert gRPC message: ${errorMessage(err)}`);
      return;
    }
    if (message.event !== Events.Pong) log.debug(`Received event via gRPC: ${message.event}`);

    if (this.messageHandler) {
      this.messageHandler(message);
    } else if (this.pending.length < this.incomingBuffer) {
      this.pending.push(message);
    } else {
      log.warn(`Incoming events buffer full, dropping message: ${message.event}`);
    }
  }

  private sendPing(): void {
    this.sendEvent({
      function: '',
      node: '',
      workflow: '',
      version: '',
      server: this.serverName,
      event: Events.Ping,
      text: 'ping',
      run: '',
      meta: null,
      payload: null,
      correlationId: '',
    }).catch((err) => log.warn(`Failed to send ping: ${errorMessage(err)}`));
  }
}
