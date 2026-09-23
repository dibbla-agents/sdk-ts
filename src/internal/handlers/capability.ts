import { EventMessage, Events } from '../../types/events';
import { CapabilityProvider, CapabilityProviderDefinition, ProviderInvoke } from '../../providers';
import { Dispatcher } from '../dispatcher/dispatcher';
import { log, errorMessage } from '../log';
import { EventSender, EventState, createEventState } from './event-state';

/** Tombstones kept for cancels that overtook their request; the oldest go first. */
const MAX_TOMBSTONES = 1000;

/**
 * The registered providers and their in-flight calls.
 */
export class CapabilityRegistry {
  private readonly providers: CapabilityProvider[] = [];
  private readonly invokers = new Map<string, ProviderInvoke>();
  private readonly inFlight = new Map<string, AbortController>();
  private readonly tombstones = new Set<string>();

  /**
   * Adds a provider, refusing definitions the workflow server would skip,
   * so a misconfigured provider fails at startup instead of never appearing.
   */
  add(provider: CapabilityProvider): void {
    const { capability, name } = provider;
    if (!name) throw new Error('capability provider name must not be empty');
    // Extra ports only work through the struct-shaped handlers: a positional
    // handler would silently drop wired inputs and never produce outputs.
    if (provider.positionalWithPorts()) {
      const full = capability === 'memory' ? 'transformFull' : 'selectFull';
      throw new Error(`capability provider ${capability}/${name} declares extra ports but implements only the positional handler — implement ${full}`);
    }
    // ":" would break the server's org-prefixed registry key, "/" its
    // capability/name separator.
    if (/[:/]/.test(name)) throw new Error(`capability provider name ${JSON.stringify(name)} must not contain ':' or '/'`);
    if (this.providers.some((p) => p.capability === capability && p.name === name)) {
      throw new Error(`capability provider ${capability}/${name} already registered`);
    }
    this.providers.push(provider);
    const invoke = provider.invoke();
    if (invoke) this.invokers.set(`${capability}/${name}`, invoke);
  }

  get size(): number {
    return this.providers.length;
  }

  definitions(serverName: string): CapabilityProviderDefinition[] {
    return this.providers.map((p) => ({ ...p.definition(), server: serverName }) as CapabilityProviderDefinition);
  }

  invoker(capability: string, name: string): ProviderInvoke | undefined {
    return this.invokers.get(`${capability}/${name}`);
  }

  /** Starts tracking a call; null when its cancel already arrived. */
  begin(correlationId: string): AbortController | null {
    if (this.tombstones.delete(correlationId)) return null;
    const controller = new AbortController();
    this.inFlight.set(correlationId, controller);
    return controller;
  }

  end(correlationId: string): void {
    this.inFlight.delete(correlationId);
  }

  /** Aborts the call, or tombstones it if its request has not started yet. */
  cancel(correlationId: string): 'aborted' | 'tombstoned' {
    const controller = this.inFlight.get(correlationId);
    if (controller) {
      this.inFlight.delete(correlationId);
      controller.abort(new Error('capability provider call abandoned by the engine'));
      return 'aborted';
    }
    this.tombstones.add(correlationId);
    if (this.tombstones.size > MAX_TOMBSTONES) {
      this.tombstones.delete(this.tombstones.values().next().value as string);
    }
    return 'tombstoned';
  }
}

interface CapabilityContext {
  serverName: string;
  communicator: EventSender;
  dispatcher: Dispatcher;
  capabilities: CapabilityRegistry;
}

function responseEvent(state: EventState, payload: Record<string, unknown>): EventMessage {
  return {
    function: state.function,
    node: state.node,
    workflow: state.workflow,
    version: state.version,
    server: '',
    event: Events.CapabilityProviderResponse,
    text: '',
    run: state.run,
    meta: null,
    payload: Buffer.from(JSON.stringify(payload)),
    correlationId: state.correlationId,
  };
}

async function sendResponse(ctx: Pick<CapabilityContext, 'communicator'>, state: EventState, payload: Record<string, unknown>): Promise<void> {
  try {
    await ctx.communicator.sendEvent(responseEvent(state, payload));
  } catch (err) {
    log.error(`Failed to send capability provider response: ${errorMessage(err)}`);
  }
}

/**
 * Answers on the response channel with an error payload (not an error
 * event), so the engine's call resolves at once with a provider failure
 * instead of timing out.
 */
export function sendCapabilityErrorResponse(ctx: Pick<CapabilityContext, 'communicator'>, state: EventState, error: string): Promise<void> {
  return sendResponse(ctx, state, { error });
}

async function handleRequest(ctx: CapabilityContext, message: EventMessage): Promise<void> {
  const state = createEventState(message, ctx.serverName);

  let request: Record<string, unknown> = {};
  if (message.payload && message.payload.length > 0) {
    try {
      const parsed: unknown = JSON.parse(message.payload.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not a JSON object');
      request = parsed as Record<string, unknown>;
    } catch (err) {
      log.debug(`Capability provider request with unusable payload (${state.correlationId}): ${errorMessage(err)}`);
      await sendCapabilityErrorResponse(ctx, state, `capability provider request payload is not valid JSON: ${errorMessage(err)}`);
      return;
    }
  }

  const capability = typeof request.capability === 'string' ? request.capability : '';
  const provider = typeof request.provider === 'string' ? request.provider : '';
  log.debug(`Capability provider request for ${JSON.stringify(capability)}/${JSON.stringify(provider)} (${state.correlationId})`);
  const invoke = ctx.capabilities.invoker(capability, provider);
  if (!invoke) {
    await sendCapabilityErrorResponse(
      ctx,
      state,
      `capability provider ${JSON.stringify(provider)} for capability ${JSON.stringify(capability)} is not implemented by this server`,
    );
    return;
  }

  // A cancel that overtook this request (it waited in the queue past the
  // engine's per-call budget) left a tombstone: the engine has abandoned the
  // call, so don't run it at all.
  const controller = ctx.capabilities.begin(state.correlationId);
  if (!controller) {
    log.info(`Capability provider call ${state.correlationId} was abandoned before dispatch: skipping handler`);
    return;
  }
  try {
    const response = await invoke(request, controller.signal);
    log.debug(
      `Capability provider ${capability}/${provider} ${typeof response.error === 'string' ? `failed: ${response.error}` : 'answered'} (${state.correlationId})`,
    );
    await sendResponse(ctx, state, response);
  } catch (err) {
    await sendCapabilityErrorResponse(ctx, state, errorMessage(err));
  } finally {
    ctx.capabilities.end(state.correlationId);
  }
}

/** Announces the registered providers; a worker with none sends nothing. */
export async function handleListCapabilityProviders(
  ctx: Pick<CapabilityContext, 'serverName' | 'communicator' | 'capabilities'>,
  state: EventState,
): Promise<void> {
  if (ctx.capabilities.size === 0) return;
  try {
    await ctx.communicator.sendEvent({
      function: state.function,
      node: state.node,
      workflow: state.workflow,
      version: state.version,
      server: ctx.serverName,
      event: Events.ResponseListCapabilityProviders,
      text: 'List of capability providers',
      run: state.run,
      meta: null,
      payload: Buffer.from(JSON.stringify(ctx.capabilities.definitions(ctx.serverName))),
      correlationId: state.correlationId,
    });
  } catch (err) {
    log.error(`Failed to send list capability providers response: ${errorMessage(err)}`);
  }
}

export function registerCapabilityHandlers(ctx: CapabilityContext): void {
  // Provider calls run in the pool, like function calls.
  ctx.dispatcher.register(Events.CapabilityProviderRequest, (message) => handleRequest(ctx, message));

  // The abandon notice (DIB-443) runs direct: a cancel queued behind the
  // very work it should stop would be useless.
  ctx.dispatcher.registerDirect(Events.CapabilityProviderCancel, (message) => {
    if (ctx.capabilities.cancel(message.correlationId) === 'aborted') {
      log.info(`Capability provider call ${message.correlationId} abandoned by engine: cancelling handler`);
    }
  });

  // Catalog pre-sync (DIB-152): one-way, before the first query. Providers
  // here are stateless (every query carries its stubs), so it is accepted
  // and ignored.
  ctx.dispatcher.register(Events.CapabilityCatalog, () => {
    log.debug('Received capability catalog pre-sync (ignored by this SDK version)');
  });
}
