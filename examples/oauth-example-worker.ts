/**
 * Example: OAuth Worker using the Dibbla SDK for TypeScript
 * 
 * This example demonstrates how to:
 * - Get OAuth access tokens for users
 * - Check which OAuth providers a user has connected
 * 
 * Supported providers:
 * - google: Google APIs (Gmail, Calendar, Drive, Sheets, etc.)
 * - microsoft: Microsoft APIs (Outlook, OneDrive, Teams, etc.)
 * - github: GitHub API
 * 
 * To run:
 * 1. Set environment variables (or use .env file):
 *    - SERVER_API_TOKEN=your-api-token
 *    - SERVER_NAME=my-oauth-worker (optional)
 * 
 * 2. Run: npx ts-node examples/oauth-example-worker.ts
 */

import * as sdk from '../src/index';
import { z } from 'zod';

// ============================================================================
// GET GOOGLE TOKEN
// ============================================================================

const GetGoogleTokenInput = z.object({
  // No input needed - uses run context
}).describe('No input required - token is retrieved for the current user');

const GetGoogleTokenOutput = z.object({
  accessToken: z.string().describe('The OAuth access token'),
  tokenType: z.string().describe('Token type (usually "Bearer")'),
  expiresAt: z.number().describe('Unix timestamp when the token expires'),
  provider: z.string().describe('The provider name ("google")'),
});

// ============================================================================
// CHECK CONNECTED PROVIDERS
// ============================================================================

const CheckConnectedProvidersInput = z.object({
  // No input needed - uses run context
}).describe('No input required - checks providers for the current user');

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
// GET MICROSOFT TOKEN
// ============================================================================

const GetMicrosoftTokenInput = z.object({
  // No input needed
}).describe('No input required - token is retrieved for the current user');

const GetMicrosoftTokenOutput = z.object({
  accessToken: z.string().describe('The OAuth access token'),
  tokenType: z.string().describe('Token type (usually "Bearer")'),
  expiresAt: z.number().describe('Unix timestamp when the token expires'),
  provider: z.string().describe('The provider name ("microsoft")'),
});

// ============================================================================
// GET GITHUB TOKEN
// ============================================================================

const GetGitHubTokenInput = z.object({
  // No input needed
}).describe('No input required - token is retrieved for the current user');

const GetGitHubTokenOutput = z.object({
  accessToken: z.string().describe('The OAuth access token'),
  tokenType: z.string().describe('Token type (usually "Bearer")'),
  expiresAt: z.number().describe('Unix timestamp when the token expires'),
  provider: z.string().describe('The provider name ("github")'),
});

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const server = sdk.create({
    serverName: process.env.SERVER_NAME || 'ts-oauth-worker',
    serverApiToken: process.env.SERVER_API_TOKEN,
  });

  // Get Google Token function
  const getGoogleTokenFn = sdk.newFunction({
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

  // Get Microsoft Token function
  const getMicrosoftTokenFn = sdk.newFunction({
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

  // Get GitHub Token function
  const getGitHubTokenFn = sdk.newFunction({
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

  // Check Connected Providers function
  const checkConnectedProvidersFn = sdk.newFunction({
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

      // Convert to output format
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

  server.registerFunction(getGoogleTokenFn);
  server.registerFunction(getMicrosoftTokenFn);
  server.registerFunction(getGitHubTokenFn);
  server.registerFunction(checkConnectedProvidersFn);

  console.log('Starting OAuth example worker...');
  await server.start();
}

main().catch(console.error);

