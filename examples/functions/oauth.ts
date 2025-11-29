/**
 * OAuth functions - get access tokens for various providers
 */

import * as sdk from '../../src/index';
import { z } from 'zod';

// ============================================================================
// SCHEMAS
// ============================================================================

const GetGoogleTokenInput = z.object({}).describe('No input required - token is retrieved for the current user');

const GetGoogleTokenOutput = z.object({
  accessToken: z.string().describe('The OAuth access token'),
  tokenType: z.string().describe('Token type (usually "Bearer")'),
  expiresAt: z.number().describe('Unix timestamp when the token expires'),
  provider: z.string().describe('The provider name ("google")'),
});

const GetMicrosoftTokenInput = z.object({}).describe('No input required - token is retrieved for the current user');

const GetMicrosoftTokenOutput = z.object({
  accessToken: z.string().describe('The OAuth access token'),
  tokenType: z.string().describe('Token type (usually "Bearer")'),
  expiresAt: z.number().describe('Unix timestamp when the token expires'),
  provider: z.string().describe('The provider name ("microsoft")'),
});

const GetGitHubTokenInput = z.object({}).describe('No input required - token is retrieved for the current user');

const GetGitHubTokenOutput = z.object({
  accessToken: z.string().describe('The OAuth access token'),
  tokenType: z.string().describe('Token type (usually "Bearer")'),
  expiresAt: z.number().describe('Unix timestamp when the token expires'),
  provider: z.string().describe('The provider name ("github")'),
});

const CheckConnectedProvidersInput = z.object({}).describe('No input required - checks providers for the current user');

const ProviderInfo = z.object({
  name: z.string().describe('Provider name (google, microsoft, github)'),
  email: z.string().describe('Email associated with the connection'),
  lastUsed: z.number().nullable().describe('Unix timestamp of last token usage'),
  scopes: z.string().describe('OAuth scopes granted'),
});

const CheckConnectedProvidersOutput = z.object({
  providers: z.array(ProviderInfo).describe('List of connected OAuth providers'),
});

// ============================================================================
// FUNCTION DEFINITIONS
// ============================================================================

export const getGoogleTokenFn = sdk.newFunction({
  name: 'get_google_token',
  version: '1.0.0',
  description: 'Gets a Google OAuth access token for the current user. Use this token to call Google APIs (Gmail, Calendar, Drive, Sheets, etc.) on behalf of the user.',
  input: GetGoogleTokenInput,
  output: GetGoogleTokenOutput,
  handler: async (_input, event, state) => {
    await state.rpc?.sendStatusEvent(event, 'Requesting Google OAuth token...');

    if (!state.oauth) {
      throw new Error('OAuth client not available');
    }

    const token = await state.oauth.getAccessToken('google', event.run);

    await state.rpc?.sendStatusEvent(event, 'Google OAuth token retrieved successfully', {
      expiresAt: token.expiresAt,
    });

    return {
      accessToken: token.accessToken,
      tokenType: token.tokenType,
      expiresAt: token.expiresAt,
      provider: token.provider,
    };
  },
});

export const getMicrosoftTokenFn = sdk.newFunction({
  name: 'get_microsoft_token',
  version: '1.0.0',
  description: 'Gets a Microsoft OAuth access token for the current user. Use this token to call Microsoft APIs (Outlook, OneDrive, Teams, etc.) on behalf of the user.',
  input: GetMicrosoftTokenInput,
  output: GetMicrosoftTokenOutput,
  handler: async (_input, event, state) => {
    await state.rpc?.sendStatusEvent(event, 'Requesting Microsoft OAuth token...');

    if (!state.oauth) {
      throw new Error('OAuth client not available');
    }

    const token = await state.oauth.getAccessToken('microsoft', event.run);

    await state.rpc?.sendStatusEvent(event, 'Microsoft OAuth token retrieved successfully', {
      expiresAt: token.expiresAt,
    });

    return {
      accessToken: token.accessToken,
      tokenType: token.tokenType,
      expiresAt: token.expiresAt,
      provider: token.provider,
    };
  },
});

export const getGitHubTokenFn = sdk.newFunction({
  name: 'get_github_token',
  version: '1.0.0',
  description: 'Gets a GitHub OAuth access token for the current user. Use this token to call GitHub APIs on behalf of the user.',
  input: GetGitHubTokenInput,
  output: GetGitHubTokenOutput,
  handler: async (_input, event, state) => {
    await state.rpc?.sendStatusEvent(event, 'Requesting GitHub OAuth token...');

    if (!state.oauth) {
      throw new Error('OAuth client not available');
    }

    const token = await state.oauth.getAccessToken('github', event.run);

    await state.rpc?.sendStatusEvent(event, 'GitHub OAuth token retrieved successfully', {
      expiresAt: token.expiresAt,
    });

    return {
      accessToken: token.accessToken,
      tokenType: token.tokenType,
      expiresAt: token.expiresAt,
      provider: token.provider,
    };
  },
});

export const checkConnectedProvidersFn = sdk.newFunction({
  name: 'check_connected_providers',
  version: '1.0.0',
  description: 'Checks which OAuth providers (Google, Microsoft, GitHub) the current user has connected. Useful to verify provider connections before attempting to use their APIs.',
  input: CheckConnectedProvidersInput,
  output: CheckConnectedProvidersOutput,
  handler: async (_input, event, state) => {
    await state.rpc?.sendStatusEvent(event, 'Checking connected OAuth providers...');

    if (!state.oauth) {
      throw new Error('OAuth client not available');
    }

    const providersMap = await state.oauth.getConnectedProviders(event.run);

    const providers: z.infer<typeof ProviderInfo>[] = [];
    for (const [name, status] of Object.entries(providersMap)) {
      providers.push({
        name,
        email: status.email,
        lastUsed: status.lastUsed,
        scopes: status.scopes,
      });
    }

    await state.rpc?.sendStatusEvent(event, `Found ${providers.length} connected provider(s)`, {
      providers: providers.map(p => p.name),
    });

    return { providers };
  },
});

