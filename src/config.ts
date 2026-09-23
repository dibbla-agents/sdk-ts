import { shouldUseTLS } from './internal/grpc/communicator';

/**
 * Configuration options for the SDK server.
 */
export interface ServerConfig {
  /** Unique identifier for this worker */
  serverName: string;
  /** Address of the gRPC workflow server */
  grpcServerAddress: string;
  /** API token for authentication. When set, it wins over a workload identity token. */
  serverApiToken: string;
  /**
   * Path to a projected workload identity token (DIB-202). Rarely needed: the
   * Dibbla platform sets DIBBLA_IDENTITY_TOKEN_FILE and the default mount is
   * probed automatically, so deployed workers need no credential config. Used
   * only when serverApiToken is empty; re-read at every (re)connect.
   */
  identityTokenFile: string;
  /**
   * Pins registration to one organization, sent as x-org-id. For tokens whose
   * owner belongs to several; the platform verifies membership. Empty means
   * the token's default organization.
   */
  orgId: string;
  /** Enable/disable TLS (null = auto-detect based on address) */
  useTLS: boolean | null;
  /**
   * Skip TLS certificate verification. Insecure: the connection stays
   * encrypted but the server is not authenticated. Only for self-signed or
   * private-CA servers in controlled environments; only has an effect with TLS.
   */
  tlsInsecureSkipVerify: boolean;
  /** Number of concurrent handlers */
  handlersConcurrency: number;
  /** Buffer size for incoming events */
  incomingEventsBuffer: number;
  /** Initial reconnect interval in seconds; doubles per failure up to 5 minutes */
  grpcReconnectIntervalSec: number;
  /** Health check interval in seconds */
  grpcHealthcheckIntervalSec: number;
  /** Ping interval in seconds (0 = disabled) */
  pingIntervalSec: number;
  /**
   * HTTP/2 keepalive ping interval in seconds (0 = 300). Do not go below 300
   * when dialing a gRPC server directly: default server enforcement answers
   * faster pings with GOAWAY "too_many_pings". Behind an HTTP/2 proxy that
   * answers pings itself (e.g. Traefik), shorter intervals such as 30 are
   * safe and detect dead connections sooner.
   */
  grpcKeepaliveTimeSec: number;
  /** HTTP/2 keepalive ack timeout in seconds (0 = 20). */
  grpcKeepaliveTimeoutSec: number;
}

/**
 * Options that can be provided when creating a server.
 * All options are optional and will use defaults if not provided.
 */
export interface ServerOptions {
  serverName?: string;
  grpcServerAddress?: string;
  serverApiToken?: string;
  identityTokenFile?: string;
  orgId?: string;
  useTLS?: boolean;
  tlsInsecureSkipVerify?: boolean;
  handlersConcurrency?: number;
  incomingEventsBuffer?: number;
  grpcReconnectIntervalSec?: number;
  grpcHealthcheckIntervalSec?: number;
  pingIntervalSec?: number;
  grpcKeepaliveTimeSec?: number;
  grpcKeepaliveTimeoutSec?: number;
}

/**
 * Get an environment variable with a default value.
 */
function getEnvWithDefault(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

/** An environment variable as an integer, or the default if unset or not an integer. */
function getEnvIntWithDefault(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value && /^-?\d+$/.test(value.trim()) ? Number.parseInt(value, 10) : defaultValue;
}

function getEnvBool(key: string): boolean {
  const value = process.env[key];
  return value === 'true' || value === '1';
}

/**
 * Create the default configuration from environment variables.
 */
export function createDefaultConfig(): ServerConfig {
  // TLS configuration with auto-detection
  let useTLS: boolean | null = null;
  const tlsEnv = process.env.GRPC_USE_TLS;
  if (tlsEnv !== undefined && tlsEnv !== '') {
    useTLS = tlsEnv === 'true' || tlsEnv === '1';
  }

  return {
    serverName: getEnvWithDefault('SERVER_NAME', 'codex-ts-worker'),
    grpcServerAddress: getEnvWithDefault('GRPC_SERVER_ADDRESS', 'grpc.dibbla.com:443'),
    serverApiToken: getEnvWithDefault('SERVER_API_TOKEN', ''),
    identityTokenFile: getEnvWithDefault('DIBBLA_IDENTITY_TOKEN_FILE', ''),
    orgId: getEnvWithDefault('SERVER_ORG_ID', ''),
    useTLS,
    tlsInsecureSkipVerify: getEnvBool('GRPC_TLS_INSECURE_SKIP_VERIFY'),
    handlersConcurrency: 8,
    incomingEventsBuffer: 100,
    grpcReconnectIntervalSec: 5,
    grpcHealthcheckIntervalSec: 30,
    pingIntervalSec: 30,
    // Lets deployed workers opt into faster dead-connection detection without a rebuild.
    grpcKeepaliveTimeSec: getEnvIntWithDefault('GRPC_KEEPALIVE_TIME_SEC', 0),
    grpcKeepaliveTimeoutSec: getEnvIntWithDefault('GRPC_KEEPALIVE_TIMEOUT_SEC', 0),
  };
}

/**
 * Merge user options with default configuration.
 */
export function mergeConfig(options: ServerOptions): ServerConfig {
  const defaults = createDefaultConfig();

  return {
    serverName: options.serverName ?? defaults.serverName,
    grpcServerAddress: options.grpcServerAddress ?? defaults.grpcServerAddress,
    serverApiToken: options.serverApiToken ?? defaults.serverApiToken,
    identityTokenFile: options.identityTokenFile ?? defaults.identityTokenFile,
    orgId: options.orgId ?? defaults.orgId,
    useTLS: options.useTLS ?? defaults.useTLS,
    tlsInsecureSkipVerify: options.tlsInsecureSkipVerify ?? defaults.tlsInsecureSkipVerify,
    handlersConcurrency: options.handlersConcurrency ?? defaults.handlersConcurrency,
    incomingEventsBuffer: options.incomingEventsBuffer ?? defaults.incomingEventsBuffer,
    grpcReconnectIntervalSec: options.grpcReconnectIntervalSec ?? defaults.grpcReconnectIntervalSec,
    grpcHealthcheckIntervalSec: options.grpcHealthcheckIntervalSec ?? defaults.grpcHealthcheckIntervalSec,
    pingIntervalSec: options.pingIntervalSec ?? defaults.pingIntervalSec,
    grpcKeepaliveTimeSec: options.grpcKeepaliveTimeSec ?? defaults.grpcKeepaliveTimeSec,
    grpcKeepaliveTimeoutSec: options.grpcKeepaliveTimeoutSec ?? defaults.grpcKeepaliveTimeoutSec,
  };
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
