import { EventMessage } from '../../types/events';

/**
 * CorrelationRouter manages request/response channels by correlation ID.
 * Used for implementing request-response patterns over the streaming gRPC connection.
 */
export class CorrelationRouter {
  private channels: Map<string, {
    resolve: (msg: EventMessage) => void;
    reject: (err: Error) => void;
  }[]> = new Map();

  /**
   * Register a pending response handler for the given correlation ID.
   * Returns a promise that resolves when a response is delivered.
   */
  register(correlationId: string, timeoutMs?: number): Promise<EventMessage> {
    return new Promise((resolve, reject) => {
      const handlers = this.channels.get(correlationId) || [];
      handlers.push({ resolve, reject });
      this.channels.set(correlationId, handlers);

      // Set up timeout if specified
      if (timeoutMs && timeoutMs > 0) {
        setTimeout(() => {
          this.remove(correlationId);
          reject(new Error(`Timeout waiting for response: ${correlationId}`));
        }, timeoutMs);
      }
    });
  }

  /**
   * Register with a callback-style interface (for compatibility with Go SDK pattern)
   */
  registerWithChannel(correlationId: string): {
    promise: Promise<EventMessage>;
    cancel: () => void;
  } {
    let resolveRef: (msg: EventMessage) => void;
    let rejectRef: (err: Error) => void;

    const promise = new Promise<EventMessage>((resolve, reject) => {
      resolveRef = resolve;
      rejectRef = reject;
      
      const handlers = this.channels.get(correlationId) || [];
      handlers.push({ resolve, reject });
      this.channels.set(correlationId, handlers);
    });

    return {
      promise,
      cancel: () => {
        this.remove(correlationId);
        rejectRef!(new Error('Request cancelled'));
      },
    };
  }

  /**
   * Remove the channel registration for the given correlation ID.
   */
  remove(correlationId: string): void {
    this.channels.delete(correlationId);
  }

  /**
   * Deliver a response message to the registered handler.
   * Returns true if a handler was found and notified.
   */
  deliver(correlationId: string, message: EventMessage): boolean {
    const handlers = this.channels.get(correlationId);
    if (!handlers || handlers.length === 0) {
      return false;
    }

    // Deliver to the first waiting handler
    const handler = handlers.shift();
    if (handler) {
      handler.resolve(message);
    }

    // Clean up if no more handlers
    if (handlers.length === 0) {
      this.channels.delete(correlationId);
    }

    return true;
  }

  /**
   * Reject all pending requests with an error.
   * Used during shutdown or disconnect.
   */
  rejectAll(error: Error): void {
    this.channels.forEach((handlers) => {
      for (const handler of handlers) {
        handler.reject(error);
      }
    });
    this.channels.clear();
  }
}

