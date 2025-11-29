import { EventMessage, Events, FunctionDefinition } from '../../types/events';
import { functionKey } from '../../types/keys';
import { WorkerFunction, GlobalState } from '../../function';
import { GrpcCommunicator } from '../grpc/communicator';
import { Dispatcher } from '../dispatcher/dispatcher';
import { GrpcCacheClient } from '../cache/cache-client';
import { GrpcStoreClient } from '../store/store-client';
import { GrpcOAuthClient } from '../oauth/oauth-client';
import { RpcClient } from '../rpc/rpc-client';

/**
 * EventState contains context for the current event being processed.
 */
export interface EventState {
  server: string;
  function: string;
  functionServer: string;
  node: string;
  workflow: string;
  version: string;
  run: string;
  correlationId: string;
}

/**
 * Create an EventState from an EventMessage.
 */
export function createEventState(
  message: EventMessage,
  functionServer: string
): EventState {
  return {
    server: message.server,
    function: message.function,
    functionServer,
    node: message.node,
    workflow: message.workflow,
    version: message.version,
    run: message.run,
    correlationId: message.correlationId,
  };
}

/**
 * HandlerContext contains all the services needed by handlers.
 */
export interface HandlerContext {
  serverName: string;
  communicator: GrpcCommunicator;
  dispatcher: Dispatcher;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  functions: Map<string, WorkerFunction<any, any>>;
  cacheClient: GrpcCacheClient;
  storeClient: GrpcStoreClient;
  oauthClient: GrpcOAuthClient;
  rpcClient: RpcClient;
}

/**
 * Events that don't require a workflow field.
 */
function isWorkflowOptionalEvent(event: string): boolean {
  switch (event) {
    case Events.CacheGetResponse:
    case Events.CacheSetResponse:
    case Events.StoreGetResponse:
    case Events.StoreSetResponse:
    case Events.OAuthTokenResponse:
    case Events.OAuthStatusResponse:
    case Events.OAuthError:
    case Events.RequestServerInfo:
    case Events.RequestServerName:
    case Events.RequestListFunctions:
      return true;
    default:
      return false;
  }
}

/**
 * Register all event handlers with the dispatcher.
 */
export function registerHandlers(ctx: HandlerContext): void {
  const { dispatcher, communicator, functions, cacheClient, storeClient, oauthClient, rpcClient, serverName } = ctx;

  // Function request handler
  dispatcher.register(Events.FunctionRequest, async (message) => {
    console.log(`[DEBUG HANDLER] ==================== FUNCTION REQUEST ====================`);
    console.log(`[DEBUG HANDLER] Function requested: ${message.function}:${message.version}`);
    console.log(`[DEBUG HANDLER] Server name from config: ${serverName}`);
    
    const eventState = createEventState(message, serverName);
    console.log(`[DEBUG HANDLER] Event state created:`, JSON.stringify(eventState, null, 2));

    const key = functionKey(serverName, message.function, message.version);
    console.log(`[DEBUG HANDLER] Looking up function with key: ${key}`);
    console.log(`[DEBUG HANDLER] Available functions: ${Array.from(functions.keys()).join(', ')}`);
    
    const fn = functions.get(key);
    console.log(`[DEBUG HANDLER] Function found: ${!!fn}`);

    if (!fn) {
      console.log(`[DEBUG HANDLER] ERROR: Function not found for key: ${key}`);
      await sendErrorEvent(communicator, eventState, 'Function not found');
      return;
    }

    try {
      console.log(`[DEBUG HANDLER] Creating global state...`);
      const globalState: GlobalState = {
        serverName,
        cache: cacheClient,
        store: storeClient,
        oauth: oauthClient,
        rpc: rpcClient,
      };

      console.log(`[DEBUG HANDLER] Executing function ${fn.name}...`);
      console.log(`[DEBUG HANDLER] Payload: ${message.payload?.toString().substring(0, 500)}`);
      
      const output = await fn.execute(message.payload!, message, globalState);
      
      console.log(`[DEBUG HANDLER] Function executed successfully!`);
      console.log(`[DEBUG HANDLER] Output length: ${output.length}`);
      console.log(`[DEBUG HANDLER] Output preview: ${output.toString().substring(0, 500)}`);
      
      await sendFunctionResponse(communicator, eventState, output);
      console.log(`[DEBUG HANDLER] Response sent!`);
    } catch (err) {
      console.log(`[DEBUG HANDLER] ERROR during execution: ${(err as Error).message}`);
      console.log(`[DEBUG HANDLER] Stack trace: ${(err as Error).stack}`);
      await sendErrorEvent(communicator, eventState, `Function execution failed: ${(err as Error).message}`);
    }
  });

  // Function response handler (for RPC calls)
  dispatcher.register(Events.FunctionResponse, (message) => {
    rpcClient.handleCallResponse(message);
  });

  // Cache response handlers
  dispatcher.register(Events.CacheGetResponse, (message) => {
    cacheClient.handleResponse(message);
  });
  dispatcher.register(Events.CacheSetResponse, (message) => {
    cacheClient.handleResponse(message);
  });

  // Store response handlers
  dispatcher.register(Events.StoreGetResponse, (message) => {
    storeClient.handleResponse(message);
  });
  dispatcher.register(Events.StoreSetResponse, (message) => {
    storeClient.handleResponse(message);
  });

  // OAuth response handlers
  dispatcher.register(Events.OAuthTokenResponse, (message) => {
    oauthClient.handleResponse(message);
  });
  dispatcher.register(Events.OAuthStatusResponse, (message) => {
    oauthClient.handleResponse(message);
  });
  dispatcher.register(Events.OAuthError, (message) => {
    oauthClient.handleResponse(message);
  });

  // Server info request handlers
  dispatcher.register(Events.RequestListFunctions, async (message) => {
    const eventState = createEventState(message, serverName);
    await handleListFunctions(communicator, functions, eventState);
  });

  dispatcher.register(Events.RequestServerName, async (message) => {
    const eventState = createEventState(message, serverName);
    await handleServerName(communicator, serverName, eventState);
  });

  dispatcher.register(Events.RequestServerInfo, async (message) => {
    const eventState = createEventState(message, serverName);
    await handleServerName(communicator, serverName, eventState);
    await handleListFunctions(communicator, functions, eventState);
  });
}

/**
 * Start listening for incoming messages and dispatching them.
 */
export function startMessageListener(ctx: HandlerContext): void {
  const { communicator, dispatcher, serverName } = ctx;

  console.log(`[DEBUG LISTENER] Starting message listener for server: ${serverName}`);
  console.log(`[DEBUG LISTENER] Registered handlers: ${Array.from(ctx.functions.keys()).join(', ')}`);

  communicator.on('message', (message: EventMessage) => {
    console.log(`[DEBUG LISTENER] ==================== INCOMING MESSAGE ====================`);
    console.log(`[DEBUG LISTENER] Event type: ${message.event}`);
    console.log(`[DEBUG LISTENER] Function: ${message.function}`);
    console.log(`[DEBUG LISTENER] Version: ${message.version}`);
    console.log(`[DEBUG LISTENER] Node: ${message.node}`);
    console.log(`[DEBUG LISTENER] Workflow: ${message.workflow}`);
    console.log(`[DEBUG LISTENER] Run: ${message.run}`);
    console.log(`[DEBUG LISTENER] Server: ${message.server}`);
    console.log(`[DEBUG LISTENER] CorrelationId: ${message.correlationId}`);
    console.log(`[DEBUG LISTENER] Has payload: ${!!message.payload}`);
    if (message.payload) {
      console.log(`[DEBUG LISTENER] Payload length: ${message.payload.length}`);
      try {
        console.log(`[DEBUG LISTENER] Payload content: ${message.payload.toString().substring(0, 500)}`);
      } catch (e) {
        console.log(`[DEBUG LISTENER] Payload (binary): ${message.payload.length} bytes`);
      }
    }
    console.log(`[DEBUG LISTENER] Is workflow optional event: ${isWorkflowOptionalEvent(message.event)}`);
    console.log(`[DEBUG LISTENER] Has handler for event: ${dispatcher.hasHandler(message.event)}`);

    if (!message.workflow && !isWorkflowOptionalEvent(message.event)) {
      console.log('[DEBUG LISTENER] SKIPPING: Workflow is empty and not an optional event');
      return;
    }

    console.log(`[DEBUG LISTENER] Dispatching message to handler...`);
    dispatcher.dispatch(message);
  });
}

/**
 * Send an error event.
 */
async function sendErrorEvent(
  communicator: GrpcCommunicator,
  eventState: EventState,
  errorText: string
): Promise<void> {
  const event: EventMessage = {
    function: eventState.function,
    node: eventState.node,
    workflow: eventState.workflow,
    version: eventState.version,
    server: eventState.functionServer,
    event: Events.Error,
    text: errorText,
    run: eventState.run,
    meta: null,
    payload: null,
    correlationId: eventState.correlationId,
  };

  try {
    await communicator.sendEvent(event);
  } catch (err) {
    console.error(`Failed to send error event: ${(err as Error).message}`);
  }
}

/**
 * Send a function response.
 */
async function sendFunctionResponse(
  communicator: GrpcCommunicator,
  eventState: EventState,
  payload: Buffer
): Promise<void> {
  const event: EventMessage = {
    function: eventState.function,
    node: eventState.node,
    workflow: eventState.workflow,
    version: eventState.version,
    server: eventState.functionServer,
    event: Events.FunctionResponse,
    text: '',
    run: eventState.run,
    meta: null,
    payload,
    correlationId: eventState.correlationId,
  };

  try {
    await communicator.sendEvent(event);
  } catch (err) {
    console.error(`Failed to send function response: ${(err as Error).message}`);
  }
}

/**
 * Handle a request for the function list.
 */
async function handleListFunctions(
  communicator: GrpcCommunicator,
  functions: Map<string, WorkerFunction>,
  eventState: EventState
): Promise<void> {
  const definitions: FunctionDefinition[] = [];

  functions.forEach((fn) => {
    definitions.push(fn.getDefinition());
  });

  const payload = Buffer.from(JSON.stringify(definitions));

  const event: EventMessage = {
    function: eventState.function,
    node: eventState.node,
    workflow: eventState.workflow,
    version: eventState.version,
    server: eventState.functionServer,
    event: Events.ResponseListFunctions,
    text: 'List of functions',
    run: eventState.run,
    meta: null,
    payload,
    correlationId: eventState.correlationId,
  };

  try {
    await communicator.sendEvent(event);
  } catch (err) {
    console.error(`Failed to send list functions response: ${(err as Error).message}`);
  }
}

/**
 * Handle a request for the server name.
 */
async function handleServerName(
  communicator: GrpcCommunicator,
  serverName: string,
  eventState: EventState
): Promise<void> {
  const event: EventMessage = {
    function: eventState.function,
    node: eventState.node,
    workflow: eventState.workflow,
    version: eventState.version,
    server: serverName,
    event: Events.ResponseServerName,
    text: serverName,
    run: eventState.run,
    meta: null,
    payload: null,
    correlationId: eventState.correlationId,
  };

  try {
    await communicator.sendEvent(event);
  } catch (err) {
    console.error(`Failed to send server name response: ${(err as Error).message}`);
  }
}

