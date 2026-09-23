/**
 * MurmurHash3 x64 128-bit, first 64 bits — the function cache key sdk-go
 * computes with github.com/spaolacci/murmur3's New64. It hashes bytes, so
 * strings are hashed as UTF-8 exactly as Go sees them; a string-based hash
 * would disagree with Go on any non-ASCII payload.
 */

const MASK = (1n << 64n) - 1n;
const C1 = 0x87c37b91114253d5n;
const C2 = 0x4cf5ad432745937fn;

const rotl = (x: bigint, r: bigint) => ((x << r) | (x >> (64n - r))) & MASK;
const mul = (a: bigint, b: bigint) => (a * b) & MASK;

function fmix(k: bigint): bigint {
  k ^= k >> 33n;
  k = mul(k, 0xff51afd7ed558ccdn);
  k ^= k >> 33n;
  k = mul(k, 0xc4ceb9fe1a85ec53n);
  k ^= k >> 33n;
  return k;
}

/** MurmurHash3_x64_128 of data with seed 0, as [h1, h2]. */
export function murmur3x64128(data: Uint8Array): [bigint, bigint] {
  const length = data.length;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const blocks = Math.floor(length / 16);
  let h1 = 0n;
  let h2 = 0n;

  for (let i = 0; i < blocks; i++) {
    let k1 = view.getBigUint64(i * 16, true);
    let k2 = view.getBigUint64(i * 16 + 8, true);

    k1 = mul(rotl(mul(k1, C1), 31n), C2);
    h1 ^= k1;
    h1 = (mul((rotl(h1, 27n) + h2) & MASK, 5n) + 0x52dce729n) & MASK;

    k2 = mul(rotl(mul(k2, C2), 33n), C1);
    h2 ^= k2;
    h2 = (mul((rotl(h2, 31n) + h1) & MASK, 5n) + 0x38495ab5n) & MASK;
  }

  const tail = blocks * 16;
  const rest = length & 15;
  let k1 = 0n;
  let k2 = 0n;
  for (let i = rest; i > 8; i--) k2 ^= BigInt(data[tail + i - 1]) << BigInt((i - 9) * 8);
  if (rest > 8) h2 ^= mul(rotl(mul(k2, C2), 33n), C1);
  for (let i = Math.min(rest, 8); i > 0; i--) k1 ^= BigInt(data[tail + i - 1]) << BigInt((i - 1) * 8);
  if (rest > 0) h1 ^= mul(rotl(mul(k1, C1), 31n), C2);

  h1 ^= BigInt(length);
  h2 ^= BigInt(length);
  h1 = (h1 + h2) & MASK;
  h2 = (h2 + h1) & MASK;
  h1 = fmix(h1);
  h2 = fmix(h2);
  h1 = (h1 + h2) & MASK;
  h2 = (h2 + h1) & MASK;
  return [h1, h2];
}

function toBytes(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return input; // includes Buffer
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  if (typeof input === 'bigint') return Buffer.from(input.toString(), 'utf8');
  if (typeof input === 'number') {
    // Go formats ints with %d and floats with %f (six decimals).
    return Buffer.from(Number.isInteger(input) ? input.toFixed(0) : input.toFixed(6), 'utf8');
  }
  return Buffer.from(JSON.stringify(input) ?? '', 'utf8');
}

/**
 * The 64-bit hash of the inputs fed in order, matching sdk-go's
 * hash.Generate: the function cache key is generateHash(payload, name, version).
 */
export function generateHash(...inputs: unknown[]): bigint {
  const parts = inputs.map(toBytes);
  return murmur3x64128(Buffer.concat(parts))[0];
}
