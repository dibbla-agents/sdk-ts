import { EventMessage, Events } from '../../types/events';
import { CorrelationRouter } from '../correlation/router';
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
 * OAuth error from the server.
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
 * GrpcOAuthClient provides OAuth token operations over the workflow gRPC stream.
 */
export class GrpcOAuthClient {
  private communicator: WorkflowCommunicator;
  private router: CorrelationRouter;
  private defaultTimeoutMs: number;
  private serverName: string;

  constructor(
    communicator: WorkflowCommunicator,
    serverName: string,
    defaultTimeoutMs: number = 30000
  ) {
    this.communicator = communicator;
    this.serverName = serverName;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.router = new CorrelationRouter();
  }

  /**
   * Request an OAuth access token for the specified provider.
   * Uses the run_id to resolve organization context automatically.
   */
  async getAccessToken(
    provider: OAuthProvider,
    runId: string,
    timeoutMs?: number
  ): Promise<OAuthTokenResponse> {
    if (!this.communicator.isConnected()) {
      throw new Error('oauth: no communicator connected');
    }

    const correlationId = uid();
    const { promise, cancel } = this.router.registerWithChannel(correlationId);

    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    const timeoutHandle = setTimeout(() => {
      cancel();
    }, timeout);

    try {
      const payload = Buffer.from(
        JSON.stringify({
          provider,
          run_id: runId,
        })
      );

      const event: EventMessage = {
        function: '',
        node: '',
        workflow: '',
        version: '',
        server: '',
        event: Events.OAuthTokenRequest,
        text: 'OAuth token request',
        run: runId,
        meta: null,
        payload,
        correlationId,
      };

      await this.communicator.sendEvent(event);

      const response = await promise;
      clearTimeout(timeoutHandle);

      return this.parseTokenResponse(response);
    } catch (err) {
      clearTimeout(timeoutHandle);
      throw err;
    }
  }

  /**
   * Check which OAuth providers are connected for the current run.
   */
  async getConnectedProviders(
    runId: string,
    timeoutMs?: number
  ): Promise<Record<string, OAuthProviderStatus>> {
    if (!this.communicator.isConnected()) {
      throw new Error('oauth: no communicator connected');
    }

    const correlationId = uid();
    const { promise, cancel } = this.router.registerWithChannel(correlationId);

    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    const timeoutHandle = setTimeout(() => {
      cancel();
    }, timeout);

    try {
      const payload = Buffer.from(
        JSON.stringify({
          run_id: runId,
        })
      );

      const event: EventMessage = {
        function: '',
        node: '',
        workflow: '',
        version: '',
        server: '',
        event: Events.OAuthStatusRequest,
        text: 'OAuth status request',
        run: runId,
        meta: null,
        payload,
        correlationId,
      };

      await this.communicator.sendEvent(event);

      const response = await promise;
      clearTimeout(timeoutHandle);

      return this.parseStatusResponse(response);
    } catch (err) {
      clearTimeout(timeoutHandle);
      throw err;
    }
  }

  /**
   * Check if a specific provider is connected.
   */
  async isProviderConnected(provider: OAuthProvider, runId: string): Promise<boolean> {
    try {
      const providers = await this.getConnectedProviders(runId);
      return provider in providers;
    } catch {
      return false;
    }
  }

  /**
   * Handle a response from the server for OAuth operations.
   */
  handleResponse(response: EventMessage): void {
    if (
      response.event !== Events.OAuthTokenResponse &&
      response.event !== Events.OAuthStatusResponse &&
      response.event !== Events.OAuthError
    ) {
      return;
    }
    this.router.deliver(response.correlationId, response);
  }

  private parseTokenResponse(response: EventMessage): OAuthTokenResponse {
    if (response.event === Events.OAuthError) {
      throw this.parseError(response);
    }

    if (!response.payload) {
      throw new Error('oauth: empty response payload');
    }

    try {
      const data = JSON.parse(response.payload.toString());
      return {
        accessToken: data.access_token,
        tokenType: data.token_type,
        expiresAt: data.expires_at,
        provider: data.provider,
      };
    } catch {
      throw new Error('oauth: failed to parse token response');
    }
  }

  private parseStatusResponse(response: EventMessage): Record<string, OAuthProviderStatus> {
    if (response.event === Events.OAuthError) {
      throw this.parseError(response);
    }

    if (!response.payload) {
      throw new Error('oauth: empty response payload');
    }

    try {
      const data = JSON.parse(response.payload.toString());
      const result: Record<string, OAuthProviderStatus> = {};

      for (const [provider, status] of Object.entries(data)) {
        const s = status as {
          connected: boolean;
          email: string;
          last_used: number | null;
          scopes: string;
        };
        result[provider] = {
          connected: s.connected,
          email: s.email,
          lastUsed: s.last_used,
          scopes: s.scopes,
        };
      }

      return result;
    } catch {
      throw new Error('oauth: failed to parse status response');
    }
  }

  private parseError(response: EventMessage): OAuthError {
    if (!response.payload) {
      return new OAuthError('unknown', 'Unknown OAuth error');
    }

    try {
      const data = JSON.parse(response.payload.toString());
      return new OAuthError(data.error || 'unknown', data.error_message || 'Unknown error');
    } catch {
      return new OAuthError('unknown', response.payload.toString());
    }
  }
}

