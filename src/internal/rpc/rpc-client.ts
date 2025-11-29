import { EventMessage, Events } from '../../types/events';
import { CorrelationRouter } from '../correlation/router';
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
 * RpcClient provides RPC-style function calls over the workflow gRPC stream.
 */
export class RpcClient {
  private communicator: WorkflowCommunicator;
  private router: CorrelationRouter;
  private serverName: string;

  constructor(communicator: WorkflowCommunicator, serverName: string) {
    this.communicator = communicator;
    this.serverName = serverName;
    this.router = new CorrelationRouter();
  }

  /**
   * Send a status event with the given text and optional payload.
   */
  async sendStatusEvent(
    eventState: EventMessage,
    text: string,
    payload?: unknown
  ): Promise<void> {
    if (!this.communicator.isConnected()) {
      throw new Error('rpc: no communicator connected');
    }

    let payloadBuffer: Buffer | null = null;
    if (payload !== undefined) {
      payloadBuffer = Buffer.from(JSON.stringify(payload));
    }

    const event: EventMessage = {
      function: eventState.function,
      node: eventState.node,
      workflow: eventState.workflow,
      version: eventState.version,
      server: eventState.server,
      event: Events.StatusMessage,
      text,
      run: eventState.run,
      meta: null,
      payload: payloadBuffer,
      correlationId: eventState.correlationId,
    };

    await this.communicator.sendEvent(event);
  }

  /**
   * Call a remote function and wait for the response.
   */
  async call(
    timeoutMinutes: number,
    executionNode: ExecutionNode,
    eventState: EventMessage,
    payload: unknown
  ): Promise<Buffer> {
    if (!this.communicator.isConnected()) {
      throw new Error('rpc: no communicator connected');
    }

    const correlationId = uid();
    const { promise, cancel } = this.router.registerWithChannel(correlationId);

    const timeoutMs = timeoutMinutes * 60 * 1000;
    const timeoutHandle = setTimeout(() => {
      cancel();
    }, timeoutMs);

    try {
      const payloadBuffer = Buffer.from(JSON.stringify(payload));

      let event: EventMessage;

      if (executionNode.type !== 'flow_tool') {
        event = {
          function: executionNode.data.function.name,
          node: executionNode.id,
          workflow: eventState.workflow,
          version: executionNode.data.function.version,
          server: executionNode.data.function.server,
          event: Events.FunctionRequest,
          text: `Node ${executionNode.id} is invoking a function from a tool server`,
          run: eventState.run,
          meta: { calling_server: eventState.server },
          payload: payloadBuffer,
          correlationId,
        };
      } else {
        event = {
          function: '',
          node: executionNode.id,
          workflow: eventState.workflow,
          version: '',
          server: eventState.server,
          event: Events.FlowNodeRequest,
          text: `Node ${executionNode.id} is invoking a flow from a tool server`,
          run: eventState.run,
          meta: null,
          payload: payloadBuffer,
          correlationId,
        };
      }

      await this.communicator.sendEvent(event);

      const response = await promise;
      clearTimeout(timeoutHandle);

      console.log(`RpcClient: Received function response for correlation ID: ${correlationId}`);

      if (!response.payload) {
        throw new Error('Received empty payload');
      }

      return response.payload;
    } catch (err) {
      clearTimeout(timeoutHandle);
      throw err;
    }
  }

  /**
   * Handle a call response from the server.
   */
  handleCallResponse(response: EventMessage): void {
    if (response.event !== Events.FunctionResponse) {
      return;
    }
    this.router.deliver(response.correlationId, response);
  }
}

