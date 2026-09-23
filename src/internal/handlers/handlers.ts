import { EventMessage, Events, FunctionDefinition } from '../../types/events';
import { functionKey } from '../../types/keys';
import { WorkerFunction, GlobalState } from '../../function';
import { Dispatcher } from '../dispatcher/dispatcher';
import { GrpcCacheClient } from '../cache/cache-client';
import { GrpcStoreClient } from '../store/store-client';
import { GrpcOAuthClient } from '../oauth/oauth-client';
import { RpcClient } from '../rpc/rpc-client';
import { log, errorMessage } from '../log';
import { CapabilityRegistry, handleListCapabilityProviders, sendCapabilityErrorResponse } from './capability';
import { EventSender, EventState, createEventState } from './event-state';

export { EventSender, EventState, createEventState, startupEventState, startupBroadcastEventState } from './event-state';

/**
 * HandlerContext contains all the services needed by handlers.
 */
export interface HandlerContext {
  serverName: string;
  communicator: EventSender;
  dispatcher: Dispatcher;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  functions: Map<string, WorkerFunction<any, any>>;
  cacheClient: GrpcCacheClient;
  storeClient: GrpcStoreClient;
  oauthClient: GrpcOAuthClient;
  rpcClient: RpcClient;
  globalState: GlobalState;
  capabilities: CapabilityRegistry;
}

/**
 * Events accepted without a workflow: responses to the worker's own
 * requests, discovery, capability provider traffic and job triggers.
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
    case Events.CapabilityProviderRequest:
    case Events.CapabilityProviderCancel:
    case Events.CapabilityCatalog:
    case Events.JobTrigger:
      return true;
    default:
      return false;
  }
}

function reply(state: EventState, event: string, fields: Partial<EventMessage> = {}): EventMessage {
  return {
    function: state.function,
    node: state.node,
    workflow: state.workflow,
    version: state.version,
    server: '',
    event,
    text: '',
    run: state.run,
    meta: null,
    payload: null,
    correlationId: state.correlationId,
    ...fields,
  };
}

async function send(ctx: { communicator: EventSender }, event: EventMessage, what: string): Promise<void> {
  try {
    await ctx.communicator.sendEvent(event);
  } catch (err) {
    log.error(`Failed to send ${what}: ${errorMessage(err)}`);
  }
}

export async function sendErrorEvent(ctx: { communicator: EventSender }, state: EventState, errorText: string): Promise<void> {
  await send(ctx, reply(state, Events.Error, { text: errorText }), 'error event');
}

async function sendFunctionResponse(ctx: HandlerContext, state: EventState, payload: Buffer): Promise<void> {
  await send(ctx, reply(state, Events.FunctionResponse, { payload }), 'function response');
}

/** Announces every registered function (response_list_functions). */
export async function handleListFunctions(ctx: Pick<HandlerContext, 'communicator' | 'functions' | 'serverName'>, state: EventState): Promise<void> {
  const definitions: FunctionDefinition[] = Array.from(ctx.functions.values(), (fn) => fn.getDefinition());
  await send(
    ctx,
    reply(state, Events.ResponseListFunctions, {
      server: ctx.serverName,
      text: 'List of functions',
      payload: Buffer.from(JSON.stringify(definitions)),
    }),
    'list functions response',
  );
}

async function handleServerName(ctx: HandlerContext, state: EventState): Promise<void> {
  await send(ctx, reply(state, Events.ResponseServerName, { server: ctx.serverName, text: ctx.serverName }), 'server name response');
}

async function handleFunctionRequest(ctx: HandlerContext, message: EventMessage): Promise<void> {
  const state = createEventState(message, ctx.serverName);
  log.debug(`Received function request: ${message.function}`);
  const fn = ctx.functions.get(functionKey(state.functionServer, state.function, state.version));
  if (!fn) {
    await sendErrorEvent(ctx, state, 'Function not found');
    return;
  }
  let output: Buffer;
  try {
    output = await fn.execute(message.payload, message, ctx.globalState);
  } catch (err) {
    await sendErrorEvent(ctx, state, `Function execution failed: ${errorMessage(err)}`);
    return;
  }
  await sendFunctionResponse(ctx, state, output);
}

/**
 * Register all event handlers with the dispatcher.
 */
export function registerHandlers(ctx: HandlerContext): void {
  const { dispatcher } = ctx;

  // Function calls run in the pool.
  dispatcher.register(Events.FunctionRequest, (message) => handleFunctionRequest(ctx, message));

  // Responses to this worker's own requests unpark pooled handlers, so they
  // must never wait for a pool slot (FAT-19).
  dispatcher.registerDirect(Events.FunctionResponse, (message) => ctx.rpcClient.handleCallResponse(message));
  dispatcher.registerDirect(Events.CacheGetResponse, (message) => ctx.cacheClient.handleResponse(message));
  dispatcher.registerDirect(Events.CacheSetResponse, (message) => ctx.cacheClient.handleResponse(message));
  dispatcher.registerDirect(Events.StoreGetResponse, (message) => ctx.storeClient.handleResponse(message));
  dispatcher.registerDirect(Events.StoreSetResponse, (message) => ctx.storeClient.handleResponse(message));
  dispatcher.registerDirect(Events.OAuthTokenResponse, (message) => ctx.oauthClient.handleResponse(message));
  dispatcher.registerDirect(Events.OAuthStatusResponse, (message) => ctx.oauthClient.handleResponse(message));
  dispatcher.registerDirect(Events.OAuthError, (message) => ctx.oauthClient.handleResponse(message));

  // Discovery.
  dispatcher.registerDirect(Events.RequestListFunctions, (message) =>
    handleListFunctions(ctx, createEventState(message, ctx.serverName)),
  );
  dispatcher.registerDirect(Events.RequestServerName, (message) => handleServerName(ctx, createEventState(message, ctx.serverName)));
  dispatcher.registerDirect(Events.RequestServerInfo, async (message) => {
    const state = createEventState(message, ctx.serverName);
    await handleServerName(ctx, state);
    await handleListFunctions(ctx, state);
    await handleListCapabilityProviders(ctx, state);
  });
}

/**
 * Feeds incoming messages to the dispatcher.
 */
export function startMessageListener(ctx: HandlerContext): void {
  const { communicator, dispatcher } = ctx;

  communicator.setMessageHandler((message: EventMessage) => {
    if (message.event === Events.Pong) return;
    if (!message.workflow && !isWorkflowOptionalEvent(message.event)) {
      log.debug(`Dropping ${message.event} without a workflow`);
      return;
    }
    if (dispatcher.dispatch(message)) return;

    // The pool queue is full. Fail the caller fast instead of letting it
    // wait out its timeout; responses keep flowing because they dispatch
    // direct.
    log.warn(`Dispatcher queue full, dropping event: ${message.event} (workflow: ${message.workflow})`);
    if (message.event === Events.FunctionRequest) {
      void sendErrorEvent(ctx, createEventState(message, ctx.serverName), 'Worker overloaded: dispatcher queue full, request dropped');
    } else if (message.event === Events.CapabilityProviderRequest) {
      // On the seat's response channel, so the engine's call resolves with a
      // coded failure instead of timing out.
      void sendCapabilityErrorResponse(
        ctx,
        createEventState(message, ctx.serverName),
        'worker overloaded: dispatcher queue full, capability provider request dropped',
      );
    }
  });
}
