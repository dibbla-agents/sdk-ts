import { EventMessage } from '../../types/events';

/**
 * Handler function type for processing event messages.
 */
export type EventHandler = (message: EventMessage) => void | Promise<void>;

/**
 * Dispatcher routes events to registered handlers and processes them
 * with controlled concurrency.
 */
export class Dispatcher {
  private registry: Map<string, EventHandler> = new Map();
  private queue: EventMessage[] = [];
  private processing = 0;
  private maxConcurrency: number;
  private running = false;

  constructor(maxConcurrency: number = 8) {
    this.maxConcurrency = maxConcurrency;
  }

  /**
   * Register a handler for a specific event type.
   */
  register(eventType: string, handler: EventHandler): void {
    console.log(`[DEBUG DISPATCHER] Registering handler for event type: ${eventType}`);
    this.registry.set(eventType, handler);
  }

  /**
   * Start the dispatcher workers.
   */
  start(): void {
    this.running = true;
    this.processQueue();
  }

  /**
   * Stop the dispatcher and wait for pending tasks to complete.
   */
  async stop(): Promise<void> {
    this.running = false;
    
    // Wait for all processing to complete
    while (this.processing > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Dispatch a message for processing.
   */
  dispatch(message: EventMessage): void {
    console.log(`[DEBUG DISPATCHER] Dispatching message: event=${message.event}, function=${message.function}`);
    console.log(`[DEBUG DISPATCHER] Queue size before: ${this.queue.length}, processing: ${this.processing}, running: ${this.running}`);
    this.queue.push(message);
    this.processQueue();
    console.log(`[DEBUG DISPATCHER] Queue size after: ${this.queue.length}`);
  }

  /**
   * Check if a handler is registered for an event type.
   */
  hasHandler(eventType: string): boolean {
    return this.registry.has(eventType);
  }

  private processQueue(): void {
    if (!this.running) return;

    while (this.queue.length > 0 && this.processing < this.maxConcurrency) {
      const message = this.queue.shift();
      if (message) {
        this.processMessage(message);
      }
    }
  }

  private async processMessage(message: EventMessage): Promise<void> {
    console.log(`[DEBUG DISPATCHER] Processing message: event=${message.event}`);
    console.log(`[DEBUG DISPATCHER] Registry has ${this.registry.size} handlers: ${Array.from(this.registry.keys()).join(', ')}`);
    this.processing++;

    try {
      const handler = this.registry.get(message.event);
      console.log(`[DEBUG DISPATCHER] Handler found for ${message.event}: ${!!handler}`);
      if (handler) {
        console.log(`[DEBUG DISPATCHER] Calling handler for ${message.event}...`);
        await handler(message);
        console.log(`[DEBUG DISPATCHER] Handler completed for ${message.event}`);
      } else {
        console.log(`[DEBUG DISPATCHER] No handler registered for event: ${message.event}`);
      }
    } catch (err) {
      console.error(`[DEBUG DISPATCHER] Error processing event ${message.event}:`, err);
    } finally {
      this.processing--;
      console.log(`[DEBUG DISPATCHER] Finished processing, processing count: ${this.processing}`);
      // Continue processing queue
      this.processQueue();
    }
  }
}

