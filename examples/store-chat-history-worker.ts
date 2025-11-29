/**
 * Example: Store Chat History Worker using the Dibbla SDK for TypeScript
 * 
 * This example demonstrates how to use the workflow store to:
 * - Persist chat history across function calls
 * - Store and retrieve arbitrary key-value data
 * - Clear stored data
 * 
 * The store is scoped per workflow, so each workflow has isolated storage.
 * 
 * To run:
 * 1. Set environment variables (or use .env file):
 *    - SERVER_API_TOKEN=your-api-token
 *    - SERVER_NAME=my-store-worker (optional)
 * 
 * 2. Run: npx ts-node examples/store-chat-history-worker.ts
 */

import * as sdk from '../src/index';
import { z } from 'zod';

// ============================================================================
// STORE CHAT HISTORY
// ============================================================================

const StoreChatHistoryInput = z.object({
  text: z.string().describe('Text to append to chat history. Use "clear" or "clear_history" to reset.'),
});

const StoreChatHistoryOutput = z.object({
  history: z.string().describe('The full chat history (newline-separated) or "cleared" if history was reset'),
});

// ============================================================================
// GENERIC KEY-VALUE STORE FUNCTIONS
// ============================================================================

const StoreSetInput = z.object({
  key: z.string().describe('Key to store data under'),
  value: z.string().describe('Value to store'),
});

const StoreSetOutput = z.object({
  success: z.boolean().describe('Whether the store operation succeeded'),
  key: z.string().describe('The key that was used'),
});

const StoreGetInput = z.object({
  key: z.string().describe('Key to retrieve data from'),
});

const StoreGetOutput = z.object({
  value: z.string().nullable().describe('Retrieved value or null if not found'),
  found: z.boolean().describe('Whether the key was found'),
});

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const server = sdk.create({
    serverName: process.env.SERVER_NAME || 'ts-store-worker',
    serverApiToken: process.env.SERVER_API_TOKEN,
  });

  // Store Chat History function
  const storeChatHistoryFn = sdk.newFunction({
    name: 'store_chat_history',
    version: '1.0.0',
    description: `Appends text to a per-workflow chat history and returns the full history.

Special commands:
- "clear" or "clear_history": Clears the stored history and returns "cleared"

The history is stored in the workflow store, so it persists across function calls
within the same workflow but is isolated from other workflows.`,
    input: StoreChatHistoryInput,
    output: StoreChatHistoryOutput,
    handler: async (input, event, state) => {
      if (!state.store) {
        throw new Error('Store client not available');
      }

      const workflowId = event.workflow || '__global__';
      const historyKey = 'chat_history';

      // Special case: clear history
      if (input.text === 'clear' || input.text === 'clear_history') {
        await state.rpc?.sendStatusEvent(event, 'Clearing chat history...');
        await state.store.setString(workflowId, historyKey, '');
        return { history: 'cleared' };
      }

      await state.rpc?.sendStatusEvent(event, 'Appending to chat history...');

      // Get existing history
      let history: string[] = [];
      try {
        const existing = await state.store.getString(workflowId, historyKey);
        if (existing) {
          history = JSON.parse(existing);
        }
      } catch {
        // Start fresh if parsing fails
        history = [];
      }

      // Append new text
      history.push(input.text);

      // Store updated history
      await state.store.setString(workflowId, historyKey, JSON.stringify(history));

      await state.rpc?.sendStatusEvent(event, `Chat history updated (${history.length} messages)`);

      return { history: history.join('\n') };
    },
  });

  // Generic Store Set function
  const storeSetFn = sdk.newFunction({
    name: 'store_set',
    version: '1.0.0',
    description: 'Store a key-value pair in the workflow store. Data persists for the duration of the workflow.',
    input: StoreSetInput,
    output: StoreSetOutput,
    handler: async (input, event, state) => {
      if (!state.store) {
        throw new Error('Store client not available');
      }

      const workflowId = event.workflow || '__global__';

      await state.rpc?.sendStatusEvent(event, `Storing value for key: ${input.key}`);

      try {
        await state.store.setString(workflowId, input.key, input.value);
        return {
          success: true,
          key: input.key,
        };
      } catch (err) {
        console.error('Failed to store data:', err);
        return {
          success: false,
          key: input.key,
        };
      }
    },
  });

  // Generic Store Get function
  const storeGetFn = sdk.newFunction({
    name: 'store_get',
    version: '1.0.0',
    description: 'Retrieve a value from the workflow store by key.',
    input: StoreGetInput,
    output: StoreGetOutput,
    handler: async (input, event, state) => {
      if (!state.store) {
        throw new Error('Store client not available');
      }

      const workflowId = event.workflow || '__global__';

      await state.rpc?.sendStatusEvent(event, `Retrieving value for key: ${input.key}`);

      try {
        const value = await state.store.getString(workflowId, input.key);
        return {
          value: value ?? null,
          found: value !== null,
        };
      } catch (err) {
        console.error('Failed to get data:', err);
        return {
          value: null,
          found: false,
        };
      }
    },
  });

  server.registerFunction(storeChatHistoryFn);
  server.registerFunction(storeSetFn);
  server.registerFunction(storeGetFn);

  console.log('Starting store chat history worker...');
  await server.start();
}

main().catch(console.error);

