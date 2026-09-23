import { EventMessage } from '../../types/events';
import { log, errorMessage } from '../log';

/**
 * Handler function type for processing event messages.
 */
export type EventHandler = (message: EventMessage) => void | Promise<void>;

/**
 * Routes events to handlers, running at most `concurrency` pooled handlers at
 * once with up to `queueSize` more waiting.
 *
 * Direct handlers bypass the pool and run at once. They exist because pooled
 * handlers wait on responses to their own requests (cache, store, OAuth, RPC):
 * if those responses queued behind requests in the same bounded pool, the
 * pool would deadlock as soon as every slot was waiting (FAT-19). Direct
 * handlers must therefore be quick.
 */
export class Dispatcher {
  private readonly pooled = new Map<string, EventHandler>();
  private readonly direct = new Map<string, EventHandler>();
  private readonly queue: EventMessage[] = [];
  private inFlight = 0;
  private running = false;
  private idle: (() => void) | null = null;

  constructor(
    private readonly concurrency: number = 8,
    private readonly queueSize: number = 100,
  ) {
    if (this.concurrency < 1) this.concurrency = 1;
  }

  /** Associates an event with a handler run by the pool. */
  register(eventType: string, handler: EventHandler): void {
    this.pooled.set(eventType, handler);
  }

  /** Associates an event with a handler run at once, outside the pool. */
  registerDirect(eventType: string, handler: EventHandler): void {
    this.direct.set(eventType, handler);
  }

  hasHandler(eventType: string): boolean {
    return this.direct.has(eventType) || this.pooled.has(eventType);
  }

  start(): void {
    this.running = true;
    this.drain();
  }

  /** Stops taking queued work and waits for running handlers to finish. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.inFlight === 0) return;
    await new Promise<void>((resolve) => (this.idle = resolve));
  }

  /**
   * Routes a message: direct handlers run at once, pooled ones run or queue.
   * Returns false when the queue is full and the message was not accepted;
   * the caller decides how to surface the overflow. Never blocks.
   */
  dispatch(message: EventMessage): boolean {
    const direct = this.direct.get(message.event);
    if (direct) {
      this.run(direct, message, false);
      return true;
    }
    if (!this.pooled.has(message.event)) {
      log.debug(`No handler registered for event: ${message.event}`);
      return true;
    }
    if (this.running && this.inFlight < this.concurrency) {
      this.run(this.pooled.get(message.event)!, message, true);
      return true;
    }
    if (this.queue.length >= this.queueSize) return false;
    this.queue.push(message);
    return true;
  }

  private run(handler: EventHandler, message: EventMessage, pooled: boolean): void {
    if (pooled) this.inFlight++;
    let result: void | Promise<void>;
    try {
      result = handler(message);
    } catch (err) {
      this.failed(message, err);
      if (pooled) this.finished();
      return;
    }
    Promise.resolve(result)
      .catch((err) => this.failed(message, err))
      .finally(() => {
        if (pooled) this.finished();
      });
  }

  private failed(message: EventMessage, err: unknown): void {
    log.error(`Handler for ${message.event} failed: ${errorMessage(err)}`);
  }

  private finished(): void {
    this.inFlight--;
    this.drain();
    if (this.inFlight === 0 && this.idle) {
      this.idle();
      this.idle = null;
    }
  }

  private drain(): void {
    while (this.running && this.inFlight < this.concurrency && this.queue.length > 0) {
      const message = this.queue.shift()!;
      this.run(this.pooled.get(message.event)!, message, true);
    }
  }
}
