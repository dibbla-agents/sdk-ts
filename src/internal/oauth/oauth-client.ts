import { EventMessage, Events } from '../../types/events';
import { CorrelationRouter, RequestOptions } from '../correlation/router';
import { uid } from '../utils/uid';
import { WorkflowCommunicator } from '../cache/cache-client';

/**
 * Supported OAuth providers.
 */
export type OAuthProvider = 'google' | 'microsoft' | 'github';

export const OAuthProviders = {
  Google: 'google' as OAuthProvider,
  Microsoft: 'microsoft' as OAuthProvider,
  GitHub: 'github' as OAuthProvider,
} as const;

/**
 * OAuth token response from the server.
 */
export interface OAuthTokenResponse {
  accessToken: string;
  tokenType: string;
  expiresAt: number;
  provider: string;
}

/**
 * OAuth provider connection status.
 */
export interface OAuthProviderStatus {
  connected: boolean;
  email: string;
  lastUsed: number | null;
  scopes: string;
}

/**
 * An oauth_error from the server, e.g. the user has not connected the provider.
 */
export class OAuthError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(`oauth error [${code}]: ${message}`);
    this.code = code;
    this.name = 'OAuthError';
  }
}

/**
 * OAuth access tokens for the user behind a run, over the workflow stream.
 * The server resolves the organization and user from the run id.
 */
export class GrpcOAuthClient {
  private readonly router = new CorrelationRouter();

  constructor(
    private readonly communicator: WorkflowCommunicator,
    private readonly serverName: string,
    private readonly defaultTimeoutMs: number = 30_000,
  ) {}

  private async request(event: string, text: string, runId: string, body: Record<string, string>, awaiting: string, options: RequestOptions): Promise<EventMessage> {
    const message: EventMessage = {
      function: '',
      node: '',
      workflow: '',
      version: '',
      server: '',
      event,
      text,
      run: runId,
      meta: null,
      payload: Buffer.from(JSON.stringify(body)),
      correlationId: uid(),
    };
    return this.router.request(message.correlationId, () => this.communicator.sendEvent(message), awaiting, {
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      signal: options.signal,
    });
  }

  /**
   * An access token for the provider, refreshed by the platform if needed.
   * Throws OAuthError when the server refuses (e.g. not connected).
   */
  async getAccessToken(provider: OAuthProvider, runId: string, options: RequestOptions = {}): Promise<OAuthTokenResponse> {
    const response = await this.request(Events.OAuthTokenRequest, 'OAuth token request', runId, { provider, run_id: runId }, 'oauth_token_response', options);
    const data = this.parse(response) as Record<string, unknown>;
    return {
      accessToken: data.access_token as string,
      tokenType: data.token_type as string,
      expiresAt: data.expires_at as number,
      provider: data.provider as string,
    };
  }

  /** The providers the run's user has connected, by provider name. */
  async getConnectedProviders(runId: string, options: RequestOptions = {}): Promise<Record<string, OAuthProviderStatus>> {
    const response = await this.request(Events.OAuthStatusRequest, 'OAuth status request', runId, { run_id: runId }, 'oauth_status_response', options);
    const data = this.parse(response) as Record<string, Record<string, unknown> | null>;
    const result: Record<string, OAuthProviderStatus> = {};
    for (const [name, status] of Object.entries(data ?? {})) {
      result[name] = {
        connected: Boolean(status?.connected),
        email: (status?.email as string) ?? '',
        lastUsed: (status?.last_used as number | null) ?? null,
        scopes: (status?.scopes as string) ?? '',
      };
    }
    return result;
  }

  /** Whether the run's user has connected the provider. Errors propagate. */
  async isProviderConnected(provider: OAuthProvider, runId: string, options?: RequestOptions): Promise<boolean> {
    return provider in (await this.getConnectedProviders(runId, options));
  }

  /** Routes oauth_token_response / oauth_status_response / oauth_error to the waiting request. */
  handleResponse(response: EventMessage): void {
    switch (response.event) {
      case Events.OAuthTokenResponse:
      case Events.OAuthStatusResponse:
      case Events.OAuthError:
        this.router.deliver(response.correlationId, response);
    }
  }

  private parse(response: EventMessage): unknown {
    if (response.event === Events.OAuthError) {
      if (!response.payload) throw new OAuthError('unknown', 'unknown error');
      const text = response.payload.toString('utf8');
      let data: { error?: string; error_message?: string };
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`oauth: error: ${text}`);
      }
      throw new OAuthError(data.error ?? '', data.error_message ?? '');
    }
    if (!response.payload || response.payload.length === 0) throw new Error('oauth: empty response payload');
    try {
      return JSON.parse(response.payload.toString('utf8'));
    } catch (err) {
      throw new Error(`oauth: failed to parse response: ${(err as Error).message}`);
    }
  }
}
