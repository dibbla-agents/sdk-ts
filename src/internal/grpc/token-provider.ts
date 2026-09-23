import * as fs from 'fs';

/**
 * Supplies the credential presented when a stream opens. The communicator
 * asks on every (re)connect, so a file-backed provider follows kubelet token
 * rotation with no extra machinery.
 */
export interface TokenProvider {
  /** The current credential; "" when none is available. */
  token(): Promise<string>;
  /** A short description for logs. */
  source(): string;
}

/** A fixed API token (SERVER_API_TOKEN / serverApiToken): local development and explicit keys. */
export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly value: string) {}

  async token(): Promise<string> {
    return this.value;
  }

  source(): string {
    return 'static api token';
  }
}

/**
 * Where the Dibbla platform mounts the projected, audience-scoped workload
 * identity token on tenant pods (DIB-202). The platform also sets
 * DIBBLA_IDENTITY_TOKEN_FILE to it; this constant is the fallback.
 */
export const DEFAULT_IDENTITY_TOKEN_PATH = '/var/run/secrets/dibbla/identity/token';

/** The environment variable the platform sets to the identity token path. */
export const IDENTITY_TOKEN_FILE_ENV = 'DIBBLA_IDENTITY_TOKEN_FILE';

/**
 * Reads the credential from a file on every call. Deliberately uncached: the
 * kubelet rotates the token (about hourly, refreshed at ~80% of its life) and
 * the next stream open must present the new one. One small read per connect
 * is negligible.
 */
export class FileTokenProvider implements TokenProvider {
  constructor(readonly path: string) {}

  async token(): Promise<string> {
    try {
      return (await fs.promises.readFile(this.path, 'utf8')).trim();
    } catch (err) {
      throw new Error(`read identity token ${this.path}: ${(err as Error).message}`);
    }
  }

  source(): string {
    return `identity token file ${this.path}`;
  }
}

/**
 * Finds the workload identity token file, if there is one: an explicit path
 * wins, then DIBBLA_IDENTITY_TOKEN_FILE, then the platform's default mount.
 * Returns null when none of them names an existing file.
 */
export function detectFileTokenProvider(explicitPath?: string): FileTokenProvider | null {
  for (const candidate of [explicitPath, process.env[IDENTITY_TOKEN_FILE_ENV], DEFAULT_IDENTITY_TOKEN_PATH]) {
    if (!candidate) continue;
    try {
      if (!fs.statSync(candidate).isDirectory()) return new FileTokenProvider(candidate);
    } catch {
      // not there; try the next candidate
    }
  }
  return null;
}
