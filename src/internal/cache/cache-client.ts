import { EventMessage, Events } from '../../types/events';
import { CorrelationRouter } from '../correlation/router';
import { uid } from '../utils/uid';

/**
 * WorkflowCommunicator interface for sending events.
 */
export interface WorkflowCommunicator {
  sendEvent(event: EventMessage): Promise<void>;
  isConnected(): boolean;
}

/**
 * GrpcCacheClient provides a cache client over the workflow gRPC stream
 * using correlation IDs for request/response matching.
 */
export class GrpcCacheClient {
  private communicator: WorkflowCommunicator;
  private router: CorrelationRouter;
  private defaultTimeoutMs: number;
  private serverName: string;

  constructor(
    communicator: WorkflowCommunicator,
    serverName: string,
    defaultTimeoutMs: number = 30000
  ) {
    this.communicator = communicator;
    this.serverName = serverName;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.router = new CorrelationRouter();
  }

  /**
   * Get a cached value by string key.
   */
  async getByString(key: string, timeoutMs?: number): Promise<Buffer | null> {
    if (!this.communicator.isConnected()) {
      throw new Error('grpccache: no communicator connected');
    }

    const correlationId = uid();
    const { promise, cancel } = this.router.registerWithChannel(correlationId);

    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    const timeoutHandle = setTimeout(() => {
      cancel();
    }, timeout);

    try {
      const event: EventMessage = {
        function: '',
        node: '',
        workflow: '',
        version: '',
        server: '',
        event: Events.CacheGetRequest,
        text: 'Cache get request',
        run: '',
        meta: {
          Key: key,
          calling_server: this.serverName,
        },
        payload: null,
        correlationId,
      };

      await this.communicator.sendEvent(event);

      const response = await promise;
      clearTimeout(timeoutHandle);

      if (!response.payload || response.payload.length === 0) {
        return null;
      }

      return response.payload;
    } catch (err) {
      clearTimeout(timeoutHandle);
      if ((err as Error).message.includes('cancelled')) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Get a cached value by numeric key.
   */
  async get(key: bigint): Promise<Buffer | null> {
    return this.getByString(key.toString());
  }

  /**
   * Set a cached value by string key with optional TTL.
   */
  async setByString(key: string, value: Buffer, ttlSeconds: number = 0): Promise<void> {
    if (!this.communicator.isConnected()) {
      throw new Error('grpccache: no communicator connected');
    }

    const correlationId = uid();

    const event: EventMessage = {
      function: '',
      node: '',
      workflow: '',
      version: '',
      server: '',
      event: Events.CacheSet,
      text: 'Cache set',
      run: '',
      meta: {
        Key: key,
        TTL: ttlSeconds,
        calling_server: this.serverName,
      },
      payload: value,
      correlationId,
    };

    await this.communicator.sendEvent(event);
  }

  /**
   * Set a cached value by numeric key.
   */
  async set(key: bigint, value: Buffer): Promise<void> {
    return this.setByString(key.toString(), value, 0);
  }

  /**
   * Set a cached value by numeric key with TTL.
   */
  async setWithTTL(key: bigint, value: Buffer, ttlMs: number): Promise<void> {
    // Whole seconds, truncated, as sdk-go sends int64(ttl.Seconds()).
    const ttlSeconds = Math.trunc(ttlMs / 1000);
    return this.setByString(key.toString(), value, ttlSeconds);
  }

  /**
   * Handle a response from the server for cache operations.
   */
  handleResponse(response: EventMessage): void {
    if (
      response.event !== Events.CacheGetResponse &&
      response.event !== Events.CacheSetResponse
    ) {
      return;
    }
    this.router.deliver(response.correlationId, response);
  }
}

