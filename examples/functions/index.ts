/**
 * Function definitions barrel file
 * 
 * Re-exports all function definitions for easy importing.
 * Import individual functions or use the `all` array to register everything.
 */

// Simple utility functions
export { greetingFn, addNumbersFn } from './simple';

// Google Sheets functions
export { readGoogleSheetsFn, updateGoogleSheetsFn } from './google-sheets';

// OAuth token functions
export {
  getGoogleTokenFn,
  getMicrosoftTokenFn,
  getGitHubTokenFn,
  checkConnectedProvidersFn,
} from './oauth';

// Store functions
export { storeChatHistoryFn, storeSetFn, storeGetFn } from './store';

// Import for the `all` array
import { greetingFn, addNumbersFn } from './simple';
import { readGoogleSheetsFn, updateGoogleSheetsFn } from './google-sheets';
import {
  getGoogleTokenFn,
  getMicrosoftTokenFn,
  getGitHubTokenFn,
  checkConnectedProvidersFn,
} from './oauth';
import { storeChatHistoryFn, storeSetFn, storeGetFn } from './store';

/**
 * All function definitions in a single array.
 * Use this for convenient bulk registration:
 * 
 * ```ts
 * import * as functions from './functions';
 * server.registerFunctions(functions.all);
 * ```
 */
export const all = [
  // Simple
  greetingFn,
  addNumbersFn,
  // Google Sheets
  readGoogleSheetsFn,
  updateGoogleSheetsFn,
  // OAuth
  getGoogleTokenFn,
  getMicrosoftTokenFn,
  getGitHubTokenFn,
  checkConnectedProvidersFn,
  // Store
  storeChatHistoryFn,
  storeSetFn,
  storeGetFn,
];

