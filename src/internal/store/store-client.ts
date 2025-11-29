import { EventMessage, Events } from '../../types/events';
import { CorrelationRouter } from '../correlation/router';
import { uid } from '../utils/uid';
import { WorkflowCommunicator } from '../cache/cache-client';

/**
 * GrpcStoreClient provides a key-value store client over the workflow gRPC stream
 * using correlation IDs for request/response matching.
 */
export class GrpcStoreClient {
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
   * Get a stored value by workflow ID and key.
   */
  async get(workflowId: string, key: string, timeoutMs?: number): Promise<Buffer | null> {
    if (!this.communicator.isConnected()) {
      throw new Error('grpcstore: no communicator connected');
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
        workflow: workflowId,
        version: '',
        server: '',
        event: Events.StoreGetRequest,
        text: 'Store get request',
        run: '',
        meta: {
          Workflow: workflowId,
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
   * Get a stored string value by workflow ID and key.
   */
  async getString(workflowId: string, key: string): Promise<string | null> {
    const buffer = await this.get(workflowId, key);
    if (!buffer) return null;
    return buffer.toString('utf-8');
  }

  /**
   * Set a stored value by workflow ID and key.
   */
  async set(workflowId: string, key: string, value: Buffer): Promise<void> {
    if (!this.communicator.isConnected()) {
      throw new Error('grpcstore: no communicator connected');
    }

    const correlationId = uid();

    const event: EventMessage = {
      function: '',
      node: '',
      workflow: workflowId,
      version: '',
      server: '',
      event: Events.StoreSetRequest,
      text: 'Store set request',
      run: '',
      meta: {
        Workflow: workflowId,
        Key: key,
        calling_server: this.serverName,
      },
      payload: value,
      correlationId,
    };

    await this.communicator.sendEvent(event);
  }

  /**
   * Set a stored string value by workflow ID and key.
   */
  async setString(workflowId: string, key: string, value: string): Promise<void> {
    return this.set(workflowId, key, Buffer.from(value, 'utf-8'));
  }

  /**
   * Handle a response from the server for store operations.
   */
  handleResponse(response: EventMessage): void {
    if (
      response.event !== Events.StoreGetResponse &&
      response.event !== Events.StoreSetResponse
    ) {
      return;
    }
    this.router.deliver(response.correlationId, response);
  }
}

