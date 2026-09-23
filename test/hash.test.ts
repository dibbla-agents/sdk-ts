import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateHash, murmur3x64128 } from '../src/internal/utils/hash';
import { uid } from '../src/internal/utils/uid';

// Produced by github.com/spaolacci/murmur3 New64, fed the parts in order, as
// sdk-go's hash.Generate does. Lengths 1-40 cover every tail branch.
const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'murmur3-go.json'), 'utf8')) as {
  parts: string[];
  key: string;
}[];

describe('cache key hash', () => {
  it('matches sdk-go on every reference vector, including non-ASCII payloads', () => {
    for (const v of vectors) {
      assert.equal(generateHash(...v.parts).toString(), v.key, `parts ${JSON.stringify(v.parts)}`);
    }
  });

  it('hashes buffers and strings alike, as bytes', () => {
    const text = '{"text":"héllo 🚀"}';
    assert.equal(generateHash(Buffer.from(text), 'f', '1'), generateHash(text, 'f', '1'));
  });

  it('is the first half of MurmurHash3_x64_128', () => {
    // Reference value for the empty input with seed 0.
    assert.deepEqual(murmur3x64128(new Uint8Array(0)), [0n, 0n]);
  });

  it('formats numbers like Go: integers with %d, floats with %f', () => {
    assert.equal(generateHash(3), generateHash('3'));
    assert.equal(generateHash(1.5), generateHash('1.500000'));
    assert.equal(generateHash(10n), generateHash('10'));
  });
});

describe('uid', () => {
  it('produces sdk-go format correlation ids with 64 bits of entropy', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = uid();
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{8}$/);
      seen.add(id);
    }
    assert.equal(seen.size, 1000);
  });
});
