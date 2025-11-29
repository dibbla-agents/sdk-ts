import { randomBytes } from 'crypto';

/**
 * Generate a random UID in the format "d83a-f68e"
 * Matches the Go SDK's utils.UID() function
 */
export function uid(): string {
  const bytes = randomBytes(4);
  const part1 = bytes.readUInt16BE(0).toString(16).padStart(4, '0');
  const part2 = bytes.readUInt16BE(2).toString(16).padStart(4, '0');
  return `${part1}-${part2}`;
}

