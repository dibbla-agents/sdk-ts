import { EventMessage, Events } from '../../types/events';
import { CorrelationRouter, RequestOptions } from '../correlation/router';
import { uid } from '../utils/uid';
import { WorkflowCommunicator } from '../cache/cache-client';

/**
 * Node data for RPC calls.
 */
export interface ExecutionNode {
  id: string;
  type: string;
  data: {
    function: {
      name: string;
      version: string;
      server: string;
    };
  };
}

/**
 * Status messages and calls to other functions, over the workflow stream.
 */
export class RpcClient {
  private readonly router = new CorrelationRouter();

  constructor(
    private readonly communicator: WorkflowCommunicator,
    private readonly serverName: string,
  ) {}

  /**
   * Sends a status update for the invocation eventState describes, with an
   * optional JSON payload.
   */
  async sendStatusEvent(eventState: EventMessage, text: string, payload?: unknown): Promise<void> {
    await this.communicator.sendEvent({
      function: eventState.function,
      node: eventState.node,
      workflow: eventState.workflow,
      version: eventState.version,
      server: eventState.server,
      event: Events.StatusMessage,
      text,
      run: eventState.run,
      meta: null,
      payload: payload === undefined ? null : Buffer.from(JSON.stringify(payload)),
      correlationId: eventState.correlationId,
    });
  }

  /**
   * Invokes the function (or, for a "flow_tool" node, the flow) an execution
   * node names, and resolves with the raw response payload.
   */
  async call(timeoutMinutes: number, executionNode: ExecutionNode, eventState: EventMessage, payload: unknown, options: { signal?: AbortSignal } = {}): Promise<Buffer> {
    const body = Buffer.from(JSON.stringify(payload));
    const correlationId = uid();
    const event: EventMessage =
      executionNode.type !== 'flow_tool'
        ? {
            function: executionNode.data.function.name,
            node: executionNode.id,
            workflow: eventState.workflow,
            version: executionNode.data.function.version,
            server: executionNode.data.function.server,
            event: Events.FunctionRequest,
            text: `Node ${executionNode.id} is invoking a function from a tool server`,
            run: eventState.run,
            meta: { calling_server: eventState.server },
            payload: body,
            correlationId,
          }
        : {
            function: '',
            node: executionNode.id,
            workflow: eventState.workflow,
            version: '',
            server: eventState.server,
            event: Events.FlowNodeRequest,
            text: `Node ${executionNode.id} is invoking a flow from a tool server`,
            run: eventState.run,
            meta: null,
            payload: body,
            correlationId,
          };

    const options_: RequestOptions & { timeoutMs: number } = { timeoutMs: timeoutMinutes * 60_000, signal: options.signal };
    const response = await this.router.request(correlationId, () => this.communicator.sendEvent(event), 'function_response', options_);
    if (!response.payload || response.payload.length === 0) {
      throw new Error('received empty payload');
    }
    return response.payload;
  }

  /** Routes function_response to the waiting call. */
  handleCallResponse(response: EventMessage): void {
    if (response.event !== Events.FunctionResponse) return;
    this.router.deliver(response.correlationId, response);
  }
}
