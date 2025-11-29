import { z, ZodTypeAny } from 'zod';
import { EventMessage, FunctionDefinition } from './types/events';
import { generateHash } from './internal/utils/hash';
import { zodToSchemaString } from './internal/utils/schema';

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

// Forward declarations for service clients
export interface CacheClient {
  get(key: bigint): Promise<Buffer | null>;
  set(key: bigint, value: Buffer): Promise<void>;
  setWithTTL(key: bigint, value: Buffer, ttlSeconds: number): Promise<void>;
  getByString(key: string): Promise<Buffer | null>;
  setByString(key: string, value: Buffer, ttlSeconds?: number): Promise<void>;
}

export interface StoreClient {
  get(workflowId: string, key: string): Promise<Buffer | null>;
  set(workflowId: string, key: string, value: Buffer): Promise<void>;
  getString(workflowId: string, key: string): Promise<string | null>;
  setString(workflowId: string, key: string, value: string): Promise<void>;
}

export interface OAuthClient {
  getAccessToken(provider: OAuthProvider, runId: string): Promise<OAuthTokenResponse>;
  getConnectedProviders(runId: string): Promise<Record<string, OAuthProviderStatus>>;
  isProviderConnected(provider: OAuthProvider, runId: string): Promise<boolean>;
}

export interface RpcClient {
  sendStatusEvent(eventState: EventMessage, text: string, payload?: unknown): Promise<void>;
  call(timeoutMinutes: number, node: ExecutionNode, eventState: EventMessage, payload: unknown): Promise<Buffer>;
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
  execute(payload: Buffer, eventMessage: EventMessage, globalState: GlobalState): Promise<Buffer>;
  setCache(cache: FunctionCache): void;
  setServer(name: string): void;
}

/**
 * Handler type for advanced functions with access to event state and global state.
 */
export type FunctionHandler<TInput, TOutput> = (
  input: TInput,
  event: EventMessage,
  state: GlobalState
) => TOutput | Promise<TOutput>;

/**
 * Handler type for simple input->output functions.
 */
export type SimpleFunctionHandler<TInput, TOutput> = (input: TInput) => TOutput | Promise<TOutput>;

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
    this.inputJsonSchema = zodToSchemaString(inputSchema);
    this.outputJsonSchema = zodToSchemaString(outputSchema);
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

  async execute(
    payload: Buffer,
    eventMessage: EventMessage,
    globalState: GlobalState
  ): Promise<Buffer> {
    console.log(`[DEBUG FUNCTION] ==================== EXECUTE START ====================`);
    console.log(`[DEBUG FUNCTION] Function: ${this.name}:${this.version}`);
    console.log(`[DEBUG FUNCTION] Is simple: ${this.isSimple}`);
    console.log(`[DEBUG FUNCTION] Payload length: ${payload?.length ?? 0}`);
    console.log(`[DEBUG FUNCTION] Payload content: ${payload?.toString().substring(0, 500)}`);
    
    // Check cache if enabled
    if (this.cache && this.cacheTTLMs > 0) {
      const cacheKey = generateHash(payload, this.name, this.version);
      console.log(`[DEBUG FUNCTION] Cache lookup [${this.name}:${this.version}] Key: ${cacheKey}`);

      const cachedResult = await this.cache.get(cacheKey);
      if (cachedResult) {
        console.log(`[DEBUG FUNCTION] Cache HIT [${this.name}:${this.version}]`);
        return cachedResult;
      }
      console.log(`[DEBUG FUNCTION] Cache MISS [${this.name}:${this.version}]`);
    }

    // Parse and validate input
    let input: TInput;
    try {
      console.log(`[DEBUG FUNCTION] Parsing input JSON...`);
      const rawInput = JSON.parse(payload.toString());
      console.log(`[DEBUG FUNCTION] Raw input:`, JSON.stringify(rawInput, null, 2));
      
      console.log(`[DEBUG FUNCTION] Coercing input types to match schema...`);
      const coercedInput = coerceToSchema(rawInput, this.inputSchema);
      console.log(`[DEBUG FUNCTION] Coerced input:`, JSON.stringify(coercedInput, null, 2));
      
      console.log(`[DEBUG FUNCTION] Validating input against schema...`);
      input = this.inputSchema.parse(coercedInput);
      console.log(`[DEBUG FUNCTION] Input validated successfully:`, JSON.stringify(input, null, 2));
    } catch (err) {
      console.log(`[DEBUG FUNCTION] ERROR parsing/validating input: ${(err as Error).message}`);
      throw new Error(`Failed to parse/validate input: ${(err as Error).message}`);
    }

    // Execute handler
    let output: TOutput;
    try {
      console.log(`[DEBUG FUNCTION] Executing handler (isSimple: ${this.isSimple})...`);
      if (this.isSimple) {
        console.log(`[DEBUG FUNCTION] Calling simple handler...`);
        output = await (this.handler as SimpleFunctionHandler<TInput, TOutput>)(input);
      } else {
        console.log(`[DEBUG FUNCTION] Calling advanced handler with event and state...`);
        output = await (this.handler as FunctionHandler<TInput, TOutput>)(
          input,
          eventMessage,
          globalState
        );
      }
      console.log(`[DEBUG FUNCTION] Handler returned:`, JSON.stringify(output, null, 2));
    } catch (err) {
      console.log(`[DEBUG FUNCTION] ERROR in handler: ${(err as Error).message}`);
      console.log(`[DEBUG FUNCTION] Stack trace: ${(err as Error).stack}`);
      throw new Error(`Handler error: ${(err as Error).message}`);
    }

    // Validate output
    try {
      console.log(`[DEBUG FUNCTION] Validating output against schema...`);
      this.outputSchema.parse(output);
      console.log(`[DEBUG FUNCTION] Output validated successfully`);
    } catch (err) {
      console.log(`[DEBUG FUNCTION] ERROR validating output: ${(err as Error).message}`);
      throw new Error(`Output validation failed: ${(err as Error).message}`);
    }

    // Serialize output
    const outputBuffer = Buffer.from(JSON.stringify(output));
    console.log(`[DEBUG FUNCTION] Output serialized, length: ${outputBuffer.length}`);

    // Cache result if enabled
    if (this.cache && this.cacheTTLMs > 0) {
      const cacheKey = generateHash(payload, this.name, this.version);
      await this.cache.setWithTTL(cacheKey, outputBuffer, this.cacheTTLMs);
      console.log(`[DEBUG FUNCTION] Cache STORE [${this.name}:${this.version}] Key: ${cacheKey} (TTL: ${this.cacheTTLMs}ms)`);
    }

    console.log(`[DEBUG FUNCTION] ==================== EXECUTE END ====================`);
    return outputBuffer;
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

