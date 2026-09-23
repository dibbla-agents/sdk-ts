import { z, ZodTypeAny } from 'zod';
import { EventMessage, FunctionDefinition } from './types/events';
import { generateHash } from './internal/utils/hash';
import { zodToSchemaString } from './internal/utils/schema';
import { log } from './internal/log';
import { Caller, callerFromEvent } from './caller';

/**
 * Coerce input data to match the expected Zod schema types.
 * This handles the common case where JSON/gRPC transports serialize
 * numbers and booleans as strings.
 */
function coerceToSchema(data: unknown, schema: ZodTypeAny): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  const typeName = schema._def.typeName;

  // Unwrap wrapper types
  if (
    typeName === 'ZodOptional' ||
    typeName === 'ZodNullable' ||
    typeName === 'ZodDefault' ||
    typeName === 'ZodReadonly'
  ) {
    const innerType = (schema._def as { innerType: ZodTypeAny }).innerType;
    return coerceToSchema(data, innerType);
  }

  if (typeName === 'ZodEffects') {
    const innerSchema = (schema._def as { schema: ZodTypeAny }).schema;
    return coerceToSchema(data, innerSchema);
  }

  // Coerce string to number
  if (typeName === 'ZodNumber' && typeof data === 'string') {
    const num = Number(data);
    return isNaN(num) ? data : num;
  }

  // Coerce string to boolean
  if (typeName === 'ZodBoolean' && typeof data === 'string') {
    if (data === 'true') return true;
    if (data === 'false') return false;
    return data;
  }

  // Coerce string to bigint
  if (typeName === 'ZodBigInt' && typeof data === 'string') {
    try {
      return BigInt(data);
    } catch {
      return data;
    }
  }

  // Recurse into objects
  if (typeName === 'ZodObject' && typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const shape = (schema._def as { shape: () => Record<string, ZodTypeAny> }).shape();
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (shape[key]) {
        result[key] = coerceToSchema(value, shape[key]);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  // Recurse into arrays
  if (typeName === 'ZodArray' && Array.isArray(data)) {
    const itemSchema = (schema._def as { type: ZodTypeAny }).type;
    return data.map(item => coerceToSchema(item, itemSchema));
  }

  // Handle unions - try each option
  if (typeName === 'ZodUnion') {
    const options = (schema._def as { options: ZodTypeAny[] }).options;
    for (const option of options) {
      const coerced = coerceToSchema(data, option);
      // If coercion changed something, use it
      if (coerced !== data) {
        return coerced;
      }
    }
  }

  return data;
}

/**
 * GlobalState provides access to SDK services within function handlers.
 */
export interface GlobalState {
  serverName: string;
  cache: CacheClient | null;
  store: StoreClient | null;
  oauth: OAuthClient | null;
  rpc: RpcClient | null;
}

/** For requests that wait for a response: a timeout (default 30s) and/or a signal. */
export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

// Forward declarations for service clients
export interface CacheClient {
  /** The cached value, or null on a miss (including a lookup that timed out). */
  get(key: bigint, options?: RequestOptions): Promise<Buffer | null>;
  set(key: bigint, value: Buffer): Promise<void>;
  setWithTTL(key: bigint, value: Buffer, ttlMs: number): Promise<void>;
  getByString(key: string, options?: RequestOptions): Promise<Buffer | null>;
  setByString(key: string, value: Buffer, ttlSeconds?: number): Promise<void>;
}

export interface StoreClient {
  /** The stored value, or null when there is none. Throws if no answer arrives in time. */
  get(workflowId: string, key: string, options?: RequestOptions): Promise<Buffer | null>;
  set(workflowId: string, key: string, value: Buffer): Promise<void>;
  getString(workflowId: string, key: string, options?: RequestOptions): Promise<string | null>;
  setString(workflowId: string, key: string, value: string): Promise<void>;
}

export interface OAuthClient {
  getAccessToken(provider: OAuthProvider, runId: string, options?: RequestOptions): Promise<OAuthTokenResponse>;
  getConnectedProviders(runId: string, options?: RequestOptions): Promise<Record<string, OAuthProviderStatus>>;
  isProviderConnected(provider: OAuthProvider, runId: string, options?: RequestOptions): Promise<boolean>;
}

export interface RpcClient {
  sendStatusEvent(eventState: EventMessage, text: string, payload?: unknown): Promise<void>;
  call(timeoutMinutes: number, node: ExecutionNode, eventState: EventMessage, payload: unknown, options?: { signal?: AbortSignal }): Promise<Buffer>;
}

export type OAuthProvider = 'google' | 'microsoft' | 'github';

export interface OAuthTokenResponse {
  accessToken: string;
  tokenType: string;
  expiresAt: number;
  provider: string;
}

export interface OAuthProviderStatus {
  connected: boolean;
  email: string;
  lastUsed: number | null;
  scopes: string;
}

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
 * FunctionCache interface for function-level caching.
 */
export interface FunctionCache {
  get(key: bigint): Promise<Buffer | null>;
  set(key: bigint, value: Buffer): Promise<void>;
  setWithTTL(key: bigint, value: Buffer, ttlMs: number): Promise<void>;
}

/**
 * What a simple function's handler learns about the invocation besides its input.
 */
export interface InvocationContext {
  /**
   * The platform-verified caller, or null when none was asserted (e.g. an
   * invocation inside a workflow run). Never derived from the input.
   */
  caller: Caller | null;
  /**
   * Cancellation for the invocation. The platform sends no deadline for
   * function calls today, so it never aborts yet; pass it to your I/O anyway
   * and a deadline will reach it without changing your handler.
   */
  signal: AbortSignal;
  /** The raw invocation event (workflow, run, node, correlation id). */
  event: EventMessage;
}

/**
 * WorkerFunction represents a registered function that can be invoked.
 */
export interface WorkerFunction<TInput = unknown, TOutput = unknown> {
  name: string;
  version: string;
  description: string;
  tags: string[];
  inputSchema: ZodTypeAny;
  outputSchema: ZodTypeAny;
  cacheTTLMs: number;
  handler: FunctionHandler<TInput, TOutput> | SimpleFunctionHandler<TInput, TOutput>;
  isSimple: boolean;
  server: string;

  // Methods
  getDefinition(): FunctionDefinition;
  /**
   * Runs the function on a request payload and returns the response payload.
   * Failures throw with the text sdk-go reports after "Function execution
   * failed: ".
   */
  execute(payload: Buffer | null, eventMessage: EventMessage, globalState: GlobalState): Promise<Buffer>;
  setCache(cache: FunctionCache): void;
  setServer(name: string): void;
}

/**
 * Handler type for advanced functions with access to event state and global state.
 * The caller is available through callerFromEvent(event).
 */
export type FunctionHandler<TInput, TOutput> = (
  input: TInput,
  event: EventMessage,
  state: GlobalState
) => TOutput | Promise<TOutput>;

/**
 * Handler type for simple input->output functions.
 */
export type SimpleFunctionHandler<TInput, TOutput> = (
  input: TInput,
  context: InvocationContext
) => TOutput | Promise<TOutput>;

/**
 * Options for creating a new function.
 */
export interface FunctionOptions<TInput, TOutput> {
  name: string;
  version: string;
  description: string;
  input: z.ZodType<TInput>;
  output: z.ZodType<TOutput>;
  handler: FunctionHandler<TInput, TOutput>;
  tags?: string[];
  /** Cache results for this long (ms). 0 (default) disables caching; below 0 uses the server's default TTL. */
  cacheTTLMs?: number;
}

/**
 * Options for creating a simple function.
 */
export interface SimpleFunctionOptions<TInput, TOutput> {
  name: string;
  version: string;
  description: string;
  input: z.ZodType<TInput>;
  output: z.ZodType<TOutput>;
  handler: SimpleFunctionHandler<TInput, TOutput>;
  tags?: string[];
}

/** An error whose message is already in sdk-go's wording. */
class ExecutionError extends Error {}

const NEVER_ABORTS = new AbortController().signal;

function describeZodError(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}

/**
 * Internal function implementation.
 */
class WorkerFunctionImpl<TInput, TOutput> implements WorkerFunction<TInput, TOutput> {
  name: string;
  version: string;
  description: string;
  tags: string[];
  inputSchema: ZodTypeAny;
  outputSchema: ZodTypeAny;
  cacheTTLMs: number;
  handler: FunctionHandler<TInput, TOutput> | SimpleFunctionHandler<TInput, TOutput>;
  isSimple: boolean;
  server: string = '';

  private cache: FunctionCache | null = null;
  private inputJsonSchema: string;
  private outputJsonSchema: string;

  constructor(
    name: string,
    version: string,
    description: string,
    inputSchema: z.ZodType<TInput>,
    outputSchema: z.ZodType<TOutput>,
    handler: FunctionHandler<TInput, TOutput> | SimpleFunctionHandler<TInput, TOutput>,
    tags: string[],
    cacheTTLMs: number,
    isSimple: boolean
  ) {
    this.name = name;
    this.version = version;
    this.description = description;
    this.inputSchema = inputSchema;
    this.outputSchema = outputSchema;
    this.handler = handler;
    this.tags = tags;
    this.cacheTTLMs = cacheTTLMs;
    this.isSimple = isSimple;

    // Generate flattened type schemas matching the Go SDK format
    this.inputJsonSchema = zodToSchemaString(inputSchema, 'input');
    this.outputJsonSchema = zodToSchemaString(outputSchema, 'output');
  }

  setCache(cache: FunctionCache): void {
    this.cache = cache;
  }

  setServer(name: string): void {
    this.server = name;
  }

  getDefinition(): FunctionDefinition {
    return {
      name: this.name,
      description: this.description,
      version: this.version,
      inputs_type: this.inputJsonSchema,
      outputs_type: this.outputJsonSchema,
      server: this.server,
      tags: this.tags,
    };
  }

  async execute(payload: Buffer | null, eventMessage: EventMessage, globalState: GlobalState): Promise<Buffer> {
    const raw = payload ?? Buffer.alloc(0);
    const caching = this.cache !== null && this.cacheTTLMs !== 0;
    const cacheKey = caching ? generateHash(raw, this.name, this.version) : 0n;

    if (caching) {
      // A cache that cannot answer is a miss, as in sdk-go.
      const cached = await this.cache!.get(cacheKey).catch((err) => {
        log.warn(`Cache lookup failed [${this.name}:${this.version}]: ${(err as Error).message}`);
        return null;
      });
      if (cached && cached.length > 0) {
        log.debug(`Cache HIT [${this.name}:${this.version}] Key: ${cacheKey}`);
        return cached;
      }
      log.debug(`Cache MISS [${this.name}:${this.version}] Key: ${cacheKey}`);
    }

    let input: TInput;
    try {
      const parsed = this.inputSchema.safeParse(coerceToSchema(JSON.parse(raw.toString('utf8')), this.inputSchema));
      if (!parsed.success) throw new Error(describeZodError(parsed.error));
      input = parsed.data;
    } catch (err) {
      throw new ExecutionError(`failed to unmarshal input: ${(err as Error).message}`);
    }

    let output: unknown;
    try {
      if (typeof this.handler !== 'function') {
        // A wiring mistake from untyped callers: name the function instead of a TypeError.
        throw new Error(`function "${this.name}" (version ${this.version}) was registered without a handler`);
      }
      if (this.isSimple) {
        const context: InvocationContext = { caller: callerFromEvent(eventMessage), signal: NEVER_ABORTS, event: eventMessage };
        output = await (this.handler as SimpleFunctionHandler<TInput, TOutput>)(input, context);
      } else {
        output = await (this.handler as FunctionHandler<TInput, TOutput>)(input, eventMessage, globalState);
      }
      // What leaves the worker is what the output schema says, as Go's
      // json.Marshal of the output struct would be.
      const checked = this.outputSchema.safeParse(output);
      if (!checked.success) throw new Error(`output does not match the output schema: ${describeZodError(checked.error)}`);
      output = checked.data;
    } catch (err) {
      throw new ExecutionError(`handler error: ${err instanceof Error ? err.message : String(err)}`);
    }

    let result: Buffer;
    try {
      result = Buffer.from(JSON.stringify(output) ?? 'null');
    } catch (err) {
      throw new ExecutionError(`failed to marshal output: ${(err as Error).message}`);
    }

    if (caching) {
      try {
        if (this.cacheTTLMs > 0) await this.cache!.setWithTTL(cacheKey, result, this.cacheTTLMs);
        else await this.cache!.set(cacheKey, result);
        log.debug(`Cache STORE [${this.name}:${this.version}] Key: ${cacheKey}`);
      } catch (err) {
        // Failing to cache must not fail a call that succeeded.
        log.warn(`Cache store failed [${this.name}:${this.version}]: ${(err as Error).message}`);
      }
    }
    return result;
  }
}

/**
 * Create a new function with full access to event state and global state.
 */
export function newFunction<TInput, TOutput>(
  options: FunctionOptions<TInput, TOutput>
): WorkerFunction<TInput, TOutput> {
  return new WorkerFunctionImpl(
    options.name,
    options.version,
    options.description,
    options.input,
    options.output,
    options.handler,
    options.tags ?? [],
    options.cacheTTLMs ?? 0,
    false
  );
}

/**
 * Create a simple function that only handles input->output transformation.
 * The handler also receives the invocation context: the verified caller and
 * a cancellation signal.
 */
export function newSimpleFunction<TInput, TOutput>(
  options: SimpleFunctionOptions<TInput, TOutput>
): WorkerFunction<TInput, TOutput> {
  return new WorkerFunctionImpl(
    options.name,
    options.version,
    options.description,
    options.input,
    options.output,
    options.handler,
    options.tags ?? [],
    0, // Simple functions don't support caching by default
    true
  );
}

// Re-export z from zod for convenience
export { z } from 'zod';
