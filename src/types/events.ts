/**
 * Canonical event names used across the system.
 * These must match the Go SDK for protocol compatibility.
 */
export const Events = {
  // Generic events
  Error: 'error',
  StatusMessage: 'status_message',
  ClientRegistration: 'client_registration',

  // Ping/Pong - Keep-alive mechanism between SDK client and workflow server
  Ping: 'ping',
  Pong: 'pong',

  // Function invocation
  FunctionRequest: 'function_request',
  FunctionResponse: 'function_response',

  // Flow invocation
  FlowNodeRequest: 'flow_node_request',

  // Cache events
  CacheGetRequest: 'cache_get_request',
  CacheGetResponse: 'cache_get_response',
  CacheSet: 'cache_set',
  CacheSetResponse: 'cache_set_response',

  // Store events
  StoreGetRequest: 'store_get_request',
  StoreGetResponse: 'store_get_response',
  StoreSetRequest: 'store_set_request',
  StoreSetResponse: 'store_set_response',

  // Server discovery/listing
  RequestListFunctions: 'request_list_functions',
  ResponseListFunctions: 'response_list_functions',
  RequestServerName: 'request_server_name',
  ResponseServerName: 'response_server_name',
  RequestServerInfo: 'request_server_info',

  // Capability providers (DIB-131): worker → server registration and
  // server → worker provider invocation.
  ResponseListCapabilityProviders: 'response_list_capability_providers',
  CapabilityProviderRequest: 'capability_provider_request',
  CapabilityProviderResponse: 'capability_provider_response',
  // One-way catalog pre-sync (DIB-152): the engine pushes the full
  // tool_search stub set at run start. No reply is expected.
  CapabilityCatalog: 'capability_catalog',
  // The engine's one-way abandon notice (DIB-443): the call with this
  // correlation id timed out or its run was terminated.
  CapabilityProviderCancel: 'capability_provider_cancel',

  // OAuth events
  OAuthTokenRequest: 'oauth_token_request',
  OAuthTokenResponse: 'oauth_token_response',
  OAuthStatusRequest: 'oauth_status_request',
  OAuthStatusResponse: 'oauth_status_response',
  OAuthError: 'oauth_error',

  // Jobs: long-running job execution
  JobRegistration: 'job_registration',
  JobTrigger: 'job_trigger',
  JobStarted: 'job_started',
  JobCompleted: 'job_completed',
  JobFailed: 'job_failed',
  TaskStarted: 'task_started',
  TaskCompleted: 'task_completed',
  TaskFailed: 'task_failed',
  TaskSkipped: 'task_skipped',
  LogMessage: 'log_message',
  ProgressUpdate: 'progress_update',
} as const;

export type EventType = (typeof Events)[keyof typeof Events];

/**
 * EventMessage is the core message structure used for all communication.
 * This must match the Go SDK's types.EventMessage and the proto definition.
 */
export interface EventMessage {
  function: string;
  node: string;
  workflow: string;
  version: string;
  server: string;
  event: string;
  text: string;
  run: string;
  meta: Record<string, unknown> | null;
  payload: Buffer | null;
  correlationId: string;
}

/**
 * FunctionDefinition represents the metadata for a registered function.
 * This is sent to the workflow server during registration.
 */
export interface FunctionDefinition {
  name: string;
  description: string;
  version: string;
  inputs_type: string;  // JSON Schema as string
  outputs_type: string; // JSON Schema as string
  server: string;
  tags: string[];
}

/**
 * Create an empty EventMessage with default values
 */
export function createEmptyEventMessage(): EventMessage {
  return {
    function: '',
    node: '',
    workflow: '',
    version: '',
    server: '',
    event: '',
    text: '',
    run: '',
    meta: null,
    payload: null,
    correlationId: '',
  };
}

