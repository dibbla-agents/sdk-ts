/**
 * Store functions - persistent key-value storage and chat history
 */

import * as sdk from '../../src/index';
import { z } from 'zod';

// ============================================================================
// SCHEMAS
// ============================================================================

const StoreChatHistoryInput = z.object({
  text: z.string().describe('Text to append to chat history. Use "clear" or "clear_history" to reset.'),
});

const StoreChatHistoryOutput = z.object({
  history: z.string().describe('The full chat history (newline-separated) or "cleared" if history was reset'),
});

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
// FUNCTION DEFINITIONS
// ============================================================================

export const storeChatHistoryFn = sdk.newFunction({
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

    if (input.text === 'clear' || input.text === 'clear_history') {
      await state.rpc?.sendStatusEvent(event, 'Clearing chat history...');
      await state.store.setString(workflowId, historyKey, '');
      return { history: 'cleared' };
    }

    await state.rpc?.sendStatusEvent(event, 'Appending to chat history...');

    let history: string[] = [];
    try {
      const existing = await state.store.getString(workflowId, historyKey);
      if (existing) {
        history = JSON.parse(existing);
      }
    } catch {
      history = [];
    }

    history.push(input.text);
    await state.store.setString(workflowId, historyKey, JSON.stringify(history));

    await state.rpc?.sendStatusEvent(event, `Chat history updated (${history.length} messages)`);

    return { history: history.join('\n') };
  },
});

export const storeSetFn = sdk.newFunction({
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

export const storeGetFn = sdk.newFunction({
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

