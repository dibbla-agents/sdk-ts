import { EventMessage, Events } from '../../types/events';
import { CorrelationRouter, RequestOptions } from '../correlation/router';
import { uid } from '../utils/uid';
import { WorkflowCommunicator } from '../cache/cache-client';

/**
 * The per-workflow key-value store, over the workflow stream. A get waits
 * for store_get_response on its correlation id; a set is fire-and-forget.
 */
export class GrpcStoreClient {
  private readonly router = new CorrelationRouter();

  constructor(
    private readonly communicator: WorkflowCommunicator,
    private readonly serverName: string,
    private readonly defaultTimeoutMs: number = 30_000,
  ) {}

  private event(event: string, text: string, workflowId: string, key: string, payload: Buffer | null): EventMessage {
    return {
      function: '',
      node: '',
      workflow: workflowId,
      version: '',
      server: '',
      event,
      text,
      run: '',
      meta: { Workflow: workflowId, Key: key, calling_server: this.serverName },
      payload,
      correlationId: uid(),
    };
  }

  /**
   * The stored value, or null when the server has none. Throws when no
   * answer arrives in time: "failed to read" must never look like "empty",
   * or a read-modify-write would overwrite data it never saw.
   */
  async get(workflowId: string, key: string, options: RequestOptions = {}): Promise<Buffer | null> {
    const event = this.event(Events.StoreGetRequest, 'Store get request', workflowId, key, null);
    const response = await this.router.request(event.correlationId, () => this.communicator.sendEvent(event), 'store_get_response', {
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      signal: options.signal,
    });
    return response.payload && response.payload.length > 0 ? response.payload : null;
  }

  async getString(workflowId: string, key: string, options?: RequestOptions): Promise<string | null> {
    const value = await this.get(workflowId, key, options);
    return value === null ? null : value.toString('utf8');
  }

  async set(workflowId: string, key: string, value: Buffer): Promise<void> {
    await this.communicator.sendEvent(this.event(Events.StoreSetRequest, 'Store set request', workflowId, key, Buffer.from(value)));
  }

  setString(workflowId: string, key: string, value: string): Promise<void> {
    return this.set(workflowId, key, Buffer.from(value, 'utf8'));
  }

  /** Routes store_get_response / store_set_response to the waiting request. */
  handleResponse(response: EventMessage): void {
    if (response.event !== Events.StoreGetResponse && response.event !== Events.StoreSetResponse) return;
    this.router.deliver(response.correlationId, response);
  }
}
