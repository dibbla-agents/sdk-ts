import { EventMessage, Events } from '../../types/events';
import { CorrelationRouter, RequestOptions, TimeoutError } from '../correlation/router';
import { uid } from '../utils/uid';
import { log } from '../log';

/**
 * WorkflowCommunicator interface for sending events.
 */
export interface WorkflowCommunicator {
  sendEvent(event: EventMessage): Promise<void>;
}

function request(event: string, text: string, fields: Partial<EventMessage>): EventMessage {
  return {
    function: '',
    node: '',
    workflow: '',
    version: '',
    server: '',
    event,
    text,
    run: '',
    meta: null,
    payload: null,
    correlationId: uid(),
    ...fields,
  };
}

/**
 * The platform cache, over the workflow stream. A lookup waits for
 * cache_get_response on its correlation id; a set is fire-and-forget.
 */
export class GrpcCacheClient {
  private readonly router = new CorrelationRouter();

  constructor(
    private readonly communicator: WorkflowCommunicator,
    private readonly serverName: string,
    private readonly defaultTimeoutMs: number = 30_000,
  ) {}

  /**
   * The cached value for a key, or null on a miss. A lookup that times out is
   * a miss too: a cache is advisory. It throws only when the request cannot
   * be sent or the signal aborts.
   */
  async getByString(key: string, options: RequestOptions = {}): Promise<Buffer | null> {
    const event = request(Events.CacheGetRequest, 'Cache get request', {
      meta: { Key: key, calling_server: this.serverName },
    });
    let response: EventMessage;
    try {
      response = await this.router.request(event.correlationId, () => this.communicator.sendEvent(event), 'cache_get_response', {
        timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
        signal: options.signal,
      });
    } catch (err) {
      if (err instanceof TimeoutError) {
        log.debug(`grpccache: ${err.message}`);
        return null;
      }
      throw err;
    }
    return response.payload && response.payload.length > 0 ? response.payload : null;
  }

  /** The cached value for a numeric key (a function cache key), or null. */
  get(key: bigint, options?: RequestOptions): Promise<Buffer | null> {
    return this.getByString(key.toString(), options);
  }

  /** Stores a value; a TTL of 0 uses the server's default. */
  async setByString(key: string, value: Buffer, ttlSeconds: number = 0): Promise<void> {
    await this.communicator.sendEvent(
      request(Events.CacheSet, 'Cache set', {
        meta: { Key: key, TTL: ttlSeconds, calling_server: this.serverName },
        payload: Buffer.from(value),
      }),
    );
  }

  set(key: bigint, value: Buffer): Promise<void> {
    return this.setByString(key.toString(), value, 0);
  }

  setWithTTL(key: bigint, value: Buffer, ttlMs: number): Promise<void> {
    // Whole seconds, truncated, as sdk-go sends int64(ttl.Seconds()).
    return this.setByString(key.toString(), value, Math.trunc(ttlMs / 1000));
  }

  /** Routes cache_get_response / cache_set_response to the waiting request. */
  handleResponse(response: EventMessage): void {
    if (response.event !== Events.CacheGetResponse && response.event !== Events.CacheSetResponse) return;
    this.router.deliver(response.correlationId, response);
  }
}
