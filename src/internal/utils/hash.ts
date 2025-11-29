import * as murmur from 'murmurhash3js';

/**
 * Generate a murmur3 hash from the given inputs.
 * Matches the Go SDK's hash.Generate() function.
 */
export function generateHash(...inputs: unknown[]): bigint {
  let combined = '';
  
  for (const input of inputs) {
    if (typeof input === 'string') {
      combined += input;
    } else if (Buffer.isBuffer(input)) {
      combined += input.toString();
    } else if (typeof input === 'number' || typeof input === 'bigint') {
      combined += input.toString();
    } else {
      try {
        combined += JSON.stringify(input);
      } catch {
        combined += String(input);
      }
    }
  }

  // murmur3 x64 128-bit hash, take first 64 bits
  const hash128 = murmur.x64.hash128(combined);
  // The hash128 returns a hex string, take first 16 chars (64 bits)
  return BigInt('0x' + hash128.substring(0, 16));
}

