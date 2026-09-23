/**
 * Dibbla Agents SDK for TypeScript
 * 
 * A TypeScript SDK for building workflow functions with gRPC communication.
 * 
 * @example
 * ```typescript
 * import * as sdk from '@dibbla/sdk-ts';
 * import { z } from 'zod';
 * 
 * const GreetingInput = z.object({ name: z.string() });
 * const GreetingOutput = z.object({ message: z.string() });
 * 
 * const server = sdk.create({
 *   serverName: 'my-worker',
 *   serverApiToken: process.env.SERVER_API_TOKEN,
 * });
 * 
 * const greetingFn = sdk.newSimpleFunction({
 *   name: 'greeting',
 *   version: '1.0.0',
 *   description: 'Generate a greeting message',
 *   input: GreetingInput,
 *   output: GreetingOutput,
 *   handler: (input) => ({ message: `Hello, ${input.name}!` }),
 *   tags: ['utility', 'greeting'],
 * });
 * 
 * server.registerFunction(greetingFn);
 * server.start();
 * ```
 */

// Main SDK exports
export { Server, create } from './sdk';
export { ServerConfig, ServerOptions } from './config';

// Function builder exports
export {
  newFunction,
  newSimpleFunction,
  WorkerFunction,
  FunctionOptions,
  SimpleFunctionOptions,
  FunctionHandler,
  SimpleFunctionHandler,
  GlobalState,
  FunctionCache,
  // Service client interfaces
  CacheClient,
  StoreClient,
  OAuthClient,
  RpcClient,
  OAuthProvider,
  OAuthTokenResponse,
  OAuthProviderStatus,
  ExecutionNode,
  InvocationContext,
  RequestOptions,
  // Re-export Zod for convenience
  z,
} from './function';

// Capability providers
export {
  Capability,
  ProviderStub,
  SelectRequest,
  SelectResponse,
  ToolSearchProviderOptions,
  PartType,
  TextPart,
  ToolCallPart,
  AttachmentPart,
  ReasoningPart,
  Part,
  Turn,
  ThreadMeta,
  TransformRequest,
  TransformResponse,
  MemoryProviderOptions,
  CapabilityProviderDefinition,
  CapabilityProvider,
  toolSearchProvider,
  memoryProvider,
} from './providers';

// Jobs
export {
  JobStatus,
  JobParameter,
  JobHandler,
  JobOptions,
  JobEventMeta,
  JobContext,
  JobLogger,
  newJob,
  generateRunId,
  generateJobRunId,
  originHeaders,
  ORIGIN_KIND_HEADER,
  ORIGIN_ID_HEADER,
  ORIGIN_LABEL_HEADER,
  ORIGIN_KIND_PIPELINE_TASK,
} from './jobs';

// Verified caller identity
export { Caller, callerFromEvent, IDENTITY_USER_AUTHENTICATED, MetaKeys } from './caller';

// Type exports
export {
  Events,
  EventType,
  EventMessage,
  FunctionDefinition,
  createEmptyEventMessage,
} from './types/events';

export { functionKey, FUNCTION_PREFIX } from './types/keys';

// OAuth provider constants and errors
export { OAuthProviders, OAuthError } from './internal/oauth/oauth-client';
export { TimeoutError } from './internal/correlation/router';

// Utility exports (for advanced use cases)
export { shouldUseTLS, NotConnectedError } from './internal/grpc/communicator';
export { setLogLevel, LogLevel } from './internal/log';
export { uid } from './internal/utils/uid';
export { generateHash } from './internal/utils/hash';
export { zodToFlattenedSchema, zodToSchemaString } from './internal/utils/schema';

