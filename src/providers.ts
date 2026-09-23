/**
 * Capability providers: custom implementations of an agent capability seat
 * (tool search selection, memory policy). They are announced alongside
 * functions but live in their own registry: they never appear in the function
 * list and are only used when a workflow binds them to an agent node.
 *
 * Payload shapes are the wire format (snake_case). Memory turns are passed
 * through as the JSON the platform sent, so a turn returned unchanged goes
 * back exactly as it came.
 */

/** Capability seats a provider can register for. */
export const Capability = {
  ToolSearch: 'tool_search',
  Memory: 'memory',
} as const;

export type Capability = (typeof Capability)[keyof typeof Capability];

// --- tool_search seat (DIB-152) ---------------------------------------------

/**
 * The trimmed tool metadata a tool_search provider selects from: name and
 * description only. No tool schema, MCP routes or anything credentials-
 * adjacent crosses the provider boundary.
 */
export interface ProviderStub {
  /**
   * The tool's unique id, exactly what to return to activate it. MCP tools
   * carry an "mcp__<server>__<tool>" prefix. Names that were not offered are
   * dropped engine-side, so only echo names you received.
   */
  name: string;
  /** The same description the agent's model sees. May be absent. */
  description?: string;
}

/** Everything the engine sends for one tool_search call (DIB-449). */
export interface SelectRequest {
  /** The raw search string the agent's model passed, verbatim. */
  query: string;
  /** The candidate set, from the node's own org-scoped pool. */
  stubs: ProviderStub[];
  /** The most names to return; the engine also cuts at topN. */
  topN: number;
  /** Values of the provider's declared extra input ports. Caller-wired and unauthenticated. */
  extraInputs: Record<string, unknown>;
}

export interface SelectResponse {
  /** The ordered subset of offered stub names to activate (order is the ranking). */
  selected: string[];
  /** Values for declared extra output ports; undeclared keys are dropped engine-side. */
  extraOutputs?: Record<string, unknown>;
}

export interface ToolSearchProviderOptions {
  name: string;
  description: string;
  version: string;
  /**
   * The selection handler. Returning [] activates nothing; throwing fails the
   * node (there is no fallback to the built-in scorer). Leave both select and
   * selectFull unset to register the provider for binding only.
   */
  select?: (query: string, stubs: ProviderStub[], topN: number) => string[] | Promise<string[]>;
  /**
   * The struct-shaped variant, required when the provider declares extra
   * ports. Wins over select when both are set. The signal aborts when the
   * engine abandons the call.
   */
  selectFull?: (request: SelectRequest, signal: AbortSignal) => SelectResponse | Promise<SelectResponse>;
  /** Ask for the tool catalog ahead of run time (e.g. to pre-index embeddings). */
  wantsCatalogSync?: boolean;
  /**
   * Extra node ports, as a JSON schema object with a top-level "properties"
   * map (property names become port names; "required" marks ports that gate
   * execution).
   */
  extraInputsSchema?: Record<string, unknown>;
  extraOutputsSchema?: Record<string, unknown>;
}

// --- memory seat (DIB-154) --------------------------------------------------
// These mirror the platform's v2 ChatBlob turn model and its JSON keys.

export type PartType = 'text' | 'tool_call' | 'attachment' | 'reasoning';

export interface TextPart {
  text: string;
}

/** A tool call, self-contained with its result. */
export interface ToolCallPart {
  tool_name: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  duration_ms?: number;
  provider_tool_id?: string;
}

/** A file reference only; bytes are never carried. */
export interface AttachmentPart {
  file_hash: string;
  name?: string;
  content_type?: string;
  download_url?: string;
  size_bytes?: number;
}

/** A provider-specific reasoning block. Keep it unchanged unless you mean to drop reasoning continuity. */
export interface ReasoningPart {
  provider?: string;
  opaque_payload?: unknown;
  summary?: string;
}

/** Exactly one payload is set, matching type. */
export interface Part {
  type: PartType;
  text?: TextPart;
  tool_call?: ToolCallPart;
  attachment?: AttachmentPart;
  reasoning?: ReasoningPart;
}

/** One user or assistant exchange. The engine rejects any other role. */
export interface Turn {
  id: string;
  role: 'user' | 'assistant' | string;
  /** RFC 3339. */
  date: string;
  run_id?: string;
  correlation_id?: string;
  provider_response_id?: string;
  parts: Part[];
}

/**
 * Context about the thread being transformed (DIB-445).
 *
 * org_id, user_id, run_id, workflow_id and node_id are asserted by the engine
 * and cannot be spoofed: partition a store on them (org_id for tenants,
 * user_id per user). thread_id and turn_count are caller-supplied: never use
 * thread_id as a tenant or user boundary. user_id is null on runs without an
 * authenticated user; avoid echoing it into returned turns, which would put
 * it in the model's context.
 */
export interface ThreadMeta {
  thread_id: string;
  turn_count: number;
  org_id?: string;
  user_id?: string | null;
  run_id?: string;
  workflow_id?: string;
  node_id?: string;
  /** Informational, declared by the calling build site; not a trust boundary. */
  model?: string;
}

/** Everything the engine sends for one memory transform (DIB-449). */
export interface TransformRequest {
  /** The message being answered. Not one of turns; the engine appends it after your history. */
  currentMessage: string;
  /** The stored turns, oldest first, in full detail. */
  turns: Turn[];
  /**
   * An enforced ceiling for the returned history. The engine does not
   * truncate: it rejects a return over the ceiling (or an absolute byte cap)
   * and fails the node.
   */
  tokenBudget: number;
  meta: ThreadMeta;
  /** Values of declared extra input ports. Caller-wired and unauthenticated. */
  extraInputs: Record<string, unknown>;
}

export interface TransformResponse {
  turns: Turn[];
  extraOutputs?: Record<string, unknown>;
}

export interface MemoryProviderOptions {
  name: string;
  description: string;
  version: string;
  /**
   * The memory handler: return the turns to inject, in order. Drop, reorder,
   * summarize or add turns freely; every turn needs a user/assistant role and
   * known part types. Throwing fails the node; there is no built-in fallback.
   *
   * The signal aborts when the engine abandons the call (its ~15 s per-call
   * budget expired, or the run was terminated). After that nobody reads your
   * return value: stop, and above all do not commit side effects.
   */
  transform?: (
    currentMessage: string,
    turns: Turn[],
    tokenBudget: number,
    meta: ThreadMeta,
    signal: AbortSignal,
  ) => Turn[] | Promise<Turn[]>;
  /** The struct-shaped variant, required with extra ports. Wins over transform. */
  transformFull?: (request: TransformRequest, signal: AbortSignal) => TransformResponse | Promise<TransformResponse>;
  /**
   * The share of the model's context window the returned history may use,
   * e.g. 0.5. Clamped to a platform maximum; 0/unset is the default. Tunes the
   * token ceiling only, never the byte cap.
   */
  maxHistoryFraction?: number;
  extraInputsSchema?: Record<string, unknown>;
  extraOutputsSchema?: Record<string, unknown>;
}

// --- registration -----------------------------------------------------------

/**
 * The registration wire format, sent as the payload of
 * response_list_capability_providers. Keep in sync with workflow-server's
 * types.CapabilityProviderDefinition.
 */
export interface CapabilityProviderDefinition {
  capability: Capability;
  name: string;
  description: string;
  version: string;
  server: string;
  contract_version: number;
  extra_inputs_schema?: Record<string, unknown>;
  extra_outputs_schema?: Record<string, unknown>;
  wants_catalog_sync: boolean;
  max_history_fraction?: number;
}

/**
 * Turns a raw capability_provider_request payload into a response payload.
 * Provider failures are encoded in the response; a throw means the request
 * itself was unusable.
 */
export type ProviderInvoke = (request: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>;

/** A provider ready to register: see toolSearchProvider and memoryProvider. */
export interface CapabilityProvider {
  readonly capability: Capability;
  readonly name: string;
  /** The registration entry, without the server name. */
  definition(): Omit<CapabilityProviderDefinition, 'server'>;
  /** Whether extra ports are declared but only a positional handler is set. */
  positionalWithPorts(): boolean;
  /** null when registered for binding only. */
  invoke(): ProviderInvoke | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const obj = (v: unknown) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const hasKeys = (v: Record<string, unknown> | undefined): v is Record<string, unknown> => v !== undefined && Object.keys(v).length > 0;
const declares = (schema: Record<string, unknown> | undefined) => schema !== undefined;

/** Creates a tool_search provider. */
export function toolSearchProvider(options: ToolSearchProviderOptions): CapabilityProvider {
  const full =
    options.selectFull ??
    (options.select
      ? async (req: SelectRequest): Promise<SelectResponse> => ({ selected: await options.select!(req.query, req.stubs, req.topN) })
      : undefined);

  return {
    capability: Capability.ToolSearch,
    name: options.name,
    definition: () => ({
      capability: Capability.ToolSearch,
      name: options.name,
      description: options.description,
      version: options.version,
      contract_version: 1,
      ...(declares(options.extraInputsSchema) ? { extra_inputs_schema: options.extraInputsSchema } : {}),
      ...(declares(options.extraOutputsSchema) ? { extra_outputs_schema: options.extraOutputsSchema } : {}),
      wants_catalog_sync: options.wantsCatalogSync ?? false,
    }),
    positionalWithPorts: () =>
      (declares(options.extraInputsSchema) || declares(options.extraOutputsSchema)) && !!options.select && !options.selectFull,
    invoke: () =>
      full
        ? async (req, signal) => {
            const out: Record<string, unknown> = {};
            try {
              const result = await full(
                {
                  query: str(req.query),
                  stubs: Array.isArray(req.stubs) ? (req.stubs as ProviderStub[]) : [],
                  topN: num(req.top_n),
                  extraInputs: obj(req.extra_inputs),
                },
                signal,
              );
              // Empty collections are left out, as Go's omitempty does.
              if (result.selected?.length) out.selected = result.selected;
              if (hasKeys(result.extraOutputs)) out.extra_outputs = result.extraOutputs;
            } catch (err) {
              return { error: errorText(err) };
            }
            return out;
          }
        : null,
  };
}

/** Creates a memory provider. */
export function memoryProvider(options: MemoryProviderOptions): CapabilityProvider {
  const full =
    options.transformFull ??
    (options.transform
      ? async (req: TransformRequest, signal: AbortSignal): Promise<TransformResponse> => ({
          turns: await options.transform!(req.currentMessage, req.turns, req.tokenBudget, req.meta, signal),
        })
      : undefined);

  return {
    capability: Capability.Memory,
    name: options.name,
    definition: () => ({
      capability: Capability.Memory,
      name: options.name,
      description: options.description,
      version: options.version,
      contract_version: 1,
      ...(declares(options.extraInputsSchema) ? { extra_inputs_schema: options.extraInputsSchema } : {}),
      ...(declares(options.extraOutputsSchema) ? { extra_outputs_schema: options.extraOutputsSchema } : {}),
      wants_catalog_sync: false,
      ...(options.maxHistoryFraction ? { max_history_fraction: options.maxHistoryFraction } : {}),
    }),
    positionalWithPorts: () =>
      (declares(options.extraInputsSchema) || declares(options.extraOutputsSchema)) && !!options.transform && !options.transformFull,
    invoke: () =>
      full
        ? async (req, signal) => {
            const out: Record<string, unknown> = {};
            try {
              const meta = obj(req.thread_meta) as unknown as ThreadMeta;
              const result = await full(
                {
                  currentMessage: str(req.current_message),
                  turns: Array.isArray(req.turns) ? (req.turns as Turn[]) : [],
                  tokenBudget: num(req.token_budget),
                  meta: { ...meta, thread_id: str(meta.thread_id), turn_count: num(meta.turn_count) },
                  extraInputs: obj(req.extra_inputs),
                },
                signal,
              );
              if (result.turns?.length) out.turns = result.turns;
              if (hasKeys(result.extraOutputs)) out.extra_outputs = result.extraOutputs;
            } catch (err) {
              return { error: errorText(err) };
            }
            return out;
          }
        : null,
  };
}
