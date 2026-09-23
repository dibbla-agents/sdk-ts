import { randomBytes } from 'crypto';

/**
 * A random correlation id like "d83af68e-1b2c3d4e": 64 bits of entropy in
 * sdk-go's format. Callers treat it as opaque.
 */
export function uid(): string {
  const bytes = randomBytes(8);
  return `${bytes.subarray(0, 4).toString('hex')}-${bytes.subarray(4).toString('hex')}`;
}
