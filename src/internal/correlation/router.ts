import { EventMessage } from '../../types/events';

/** Options for a request that waits for its response. */
export interface RequestOptions {
  /** Give up after this long. Defaults to the client's timeout (30s). */
  timeoutMs?: number;
  /** Give up when this aborts; the rejection is the signal's reason. */
  signal?: AbortSignal;
}

/** A response did not arrive in time. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Pairs requests sent on the event stream with the responses that carry the
 * same correlation id.
 */
export class CorrelationRouter {
  private readonly waiters = new Map<string, (message: EventMessage) => void>();

  /**
   * Sends a request and resolves with its response. The waiter is registered
   * before sending, so a fast response cannot be missed; every outcome
   * (response, timeout, abort, send failure) removes it.
   */
  request(correlationId: string, send: () => Promise<void>, awaiting: string, options: RequestOptions & { timeoutMs: number }): Promise<EventMessage> {
    const { timeoutMs, signal } = options;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => finish(() => reject(signal!.reason));
      const finish = (settle: () => void) => {
        if (!this.waiters.has(correlationId)) return;
        this.waiters.delete(correlationId);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        settle();
      };

      this.waiters.set(correlationId, (message) => finish(() => resolve(message)));
      // As with a Go context deadline, a timeout of 0 or less expires at once.
      timer = setTimeout(
        () => finish(() => reject(new TimeoutError(`timed out after ${timeoutMs}ms waiting for ${awaiting}`))),
        Math.max(0, timeoutMs),
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      send().catch((err) => finish(() => reject(err)));
    });
  }

  /**
   * Hands a response to its waiting request. Returns false when nobody is
   * waiting (a late or duplicate response), which is dropped.
   */
  deliver(correlationId: string, message: EventMessage): boolean {
    const waiter = this.waiters.get(correlationId);
    if (!waiter) return false;
    waiter(message);
    return true;
  }

  /** Requests still waiting for a response. */
  get pending(): number {
    return this.waiters.size;
  }
}
