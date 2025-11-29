/**
 * Key generation utilities.
 * Must match the Go SDK's types/keys.go for consistency.
 */

export const FUNCTION_PREFIX = 'function:';

/**
 * Generate the canonical storage key for a function entry.
 * Format: function:<server>:<name>:<version>
 */
export function functionKey(server: string, name: string, version: string): string {
  return `${FUNCTION_PREFIX}${server}:${name}:${version}`;
}

