import { shouldUseTLS } from './internal/grpc/communicator';

/**
 * Configuration options for the SDK server.
 */
export interface ServerConfig {
  /** Unique identifier for this worker */
  serverName: string;
  /** Address of the gRPC workflow server */
  grpcServerAddress: string;
  /** API token for authentication */
  serverApiToken: string;
  /** Enable/disable TLS (null = auto-detect based on address) */
  useTLS: boolean | null;
  /** Number of concurrent handlers */
  handlersConcurrency: number;
  /** Buffer size for incoming events */
  incomingEventsBuffer: number;
  /** Reconnect interval in seconds */
  grpcReconnectIntervalSec: number;
  /** Health check interval in seconds */
  grpcHealthcheckIntervalSec: number;
  /** Ping interval in seconds (0 = disabled) */
  pingIntervalSec: number;
}

/**
 * Options that can be provided when creating a server.
 * All options are optional and will use defaults if not provided.
 */
export interface ServerOptions {
  serverName?: string;
  grpcServerAddress?: string;
  serverApiToken?: string;
  useTLS?: boolean;
  handlersConcurrency?: number;
  incomingEventsBuffer?: number;
  grpcReconnectIntervalSec?: number;
  grpcHealthcheckIntervalSec?: number;
  pingIntervalSec?: number;
}

/**
 * Get an environment variable with a default value.
 */
function getEnvWithDefault(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

/**
 * Create the default configuration from environment variables.
 */
export function createDefaultConfig(): ServerConfig {
  const grpcServerAddress = getEnvWithDefault('GRPC_SERVER_ADDRESS', 'grpc.dibbla.com:443');

  // TLS configuration with auto-detection
  let useTLS: boolean | null = null;
  const tlsEnv = process.env.GRPC_USE_TLS;
  if (tlsEnv !== undefined && tlsEnv !== '') {
    useTLS = tlsEnv === 'true' || tlsEnv === '1';
  }

  return {
    serverName: getEnvWithDefault('SERVER_NAME', 'codex-ts-worker'),
    grpcServerAddress,
    serverApiToken: getEnvWithDefault('SERVER_API_TOKEN', ''),
    useTLS,
    handlersConcurrency: 8,
    incomingEventsBuffer: 100,
    grpcReconnectIntervalSec: 5,
    grpcHealthcheckIntervalSec: 30,
    pingIntervalSec: 30,
  };
}

/**
 * Merge user options with default configuration.
 */
export function mergeConfig(options: ServerOptions): ServerConfig {
  const defaults = createDefaultConfig();

  const merged: ServerConfig = {
    serverName: options.serverName ?? defaults.serverName,
    grpcServerAddress: options.grpcServerAddress ?? defaults.grpcServerAddress,
    serverApiToken: options.serverApiToken ?? defaults.serverApiToken,
    useTLS: options.useTLS ?? defaults.useTLS,
    handlersConcurrency: options.handlersConcurrency ?? defaults.handlersConcurrency,
    incomingEventsBuffer: options.incomingEventsBuffer ?? defaults.incomingEventsBuffer,
    grpcReconnectIntervalSec: options.grpcReconnectIntervalSec ?? defaults.grpcReconnectIntervalSec,
    grpcHealthcheckIntervalSec: options.grpcHealthcheckIntervalSec ?? defaults.grpcHealthcheckIntervalSec,
    pingIntervalSec: options.pingIntervalSec ?? defaults.pingIntervalSec,
  };

  return merged;
}

/**
 * Resolve the TLS setting based on configuration and address.
 */
export function resolveTLS(config: ServerConfig): boolean {
  if (config.useTLS !== null) {
    return config.useTLS;
  }
  return shouldUseTLS(config.grpcServerAddress);
}

