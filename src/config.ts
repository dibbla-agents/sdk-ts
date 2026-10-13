import { shouldUseTLS } from './internal/grpc/communicator';

/**
 * Configuration options for the SDK server.
 */
export interface ServerConfig {
  /** Unique identifier for this worker */
  serverName: string;
  /**
   * Address of the gRPC workflow server. Precedence: the grpcServerAddress
   * option, then GRPC_SERVER_ADDRESS, then DIBBLA_GRPC_SERVER_ADDRESS (set by
   * the Dibbla platform to the install the worker is deployed on, DIB-1430),
   * then grpc.dibbla.com:443.
   */
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
  /**
   * Enable/disable TLS: the useTLS option, then GRPC_USE_TLS, then the
   * platform's DIBBLA_GRPC_USE_TLS when the address is the platform's
   * DIBBLA_GRPC_SERVER_ADDRESS. null = auto-detect based on address.
   */
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

/** Dibbla's hosted platform, used when nothing names a server. */
const DEFAULT_GRPC_SERVER_ADDRESS = 'grpc.dibbla.com:443';

/**
 * Set by the Dibbla platform (deploy-api, DIB-1430) on every tenant container:
 * the gRPC address of the install the worker is deployed on, and whether it
 * speaks TLS. They are why a worker deployed on a self-hosted install reaches
 * that install rather than grpc.dibbla.com with no configuration. The
 * platform reserves the DIBBLA_ prefix, so users cannot set these.
 */
const PLATFORM_GRPC_SERVER_ADDRESS_ENV = 'DIBBLA_GRPC_SERVER_ADDRESS';
const PLATFORM_GRPC_USE_TLS_ENV = 'DIBBLA_GRPC_USE_TLS';

/**
 * Get an environment variable with a default value.
 */
function getEnvWithDefault(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

/** An environment variable with surrounding whitespace removed; blank is unset. */
function getEnvTrimmed(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

/** true/1 and false/0; anything else is no hint. */
function parseTLSHint(value: string | undefined): boolean | null {
  switch (value?.trim()) {
    case 'true':
    case '1':
      return true;
    case 'false':
    case '0':
      return false;
    default:
      return null;
  }
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
 * The configuration the environment describes, and the platform's TLS hint:
 * DIBBLA_GRPC_USE_TLS, non-null only when the address came from
 * DIBBLA_GRPC_SERVER_ADDRESS, because the hint describes the platform's
 * address and never one the user chose. config.useTLS is GRPC_USE_TLS alone.
 */
function readEnvironment(): { config: ServerConfig; platformUseTLS: boolean | null } {
  // TLS configuration with auto-detection
  let useTLS: boolean | null = null;
  const tlsEnv = process.env.GRPC_USE_TLS;
  if (tlsEnv !== undefined && tlsEnv !== '') {
    useTLS = tlsEnv === 'true' || tlsEnv === '1';
  }

  // GRPC_SERVER_ADDRESS, else the platform's address, else the hosted default.
  const userAddress = getEnvTrimmed('GRPC_SERVER_ADDRESS');
  const platformAddress = userAddress === undefined ? getEnvTrimmed(PLATFORM_GRPC_SERVER_ADDRESS_ENV) : undefined;
  const platformUseTLS =
    platformAddress === undefined ? null : parseTLSHint(process.env[PLATFORM_GRPC_USE_TLS_ENV]);

  const config: ServerConfig = {
    serverName: getEnvWithDefault('SERVER_NAME', 'codex-ts-worker'),
    grpcServerAddress: userAddress ?? platformAddress ?? DEFAULT_GRPC_SERVER_ADDRESS,
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
  return { config, platformUseTLS };
}

/**
 * Create the default configuration from environment variables.
 */
export function createDefaultConfig(): ServerConfig {
  const { config, platformUseTLS } = readEnvironment();
  return { ...config, useTLS: config.useTLS ?? platformUseTLS };
}

/**
 * Merge user options with default configuration.
 */
export function mergeConfig(options: ServerOptions): ServerConfig {
  const { config: defaults, platformUseTLS } = readEnvironment();
  // The platform's TLS hint describes the platform's address; an address
  // passed as an option is the caller's, so the hint does not apply to it.
  const addressFromOption = options.grpcServerAddress != null;

  return {
    serverName: options.serverName ?? defaults.serverName,
    grpcServerAddress: options.grpcServerAddress ?? defaults.grpcServerAddress,
    serverApiToken: options.serverApiToken ?? defaults.serverApiToken,
    identityTokenFile: options.identityTokenFile ?? defaults.identityTokenFile,
    orgId: options.orgId ?? defaults.orgId,
    useTLS: options.useTLS ?? defaults.useTLS ?? (addressFromOption ? null : platformUseTLS),
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
