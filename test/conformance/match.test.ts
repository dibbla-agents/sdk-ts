import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { match, substitute } from '../../conformance/runner/match';

const passes = (expected: unknown, actual: unknown, vars = {}) => match(expected, actual, vars);

describe('conformance matcher', () => {
  it('matches scalars exactly', () => {
    assert.ok(passes('a', 'a').ok);
    assert.ok(!passes('a', 'b').ok);
    assert.ok(passes(1, 1).ok);
    assert.ok(!passes(1, '1').ok);
    assert.ok(passes(null, null).ok);
    assert.ok(!passes(null, undefined).ok);
    assert.ok(!passes(false, 0).ok);
  });

  it('holds objects to exactly the expected keys', () => {
    assert.ok(passes({ a: 1 }, { a: 1 }).ok);
    const extra = passes({ a: 1 }, { a: 1, b: 2 });
    assert.ok(!extra.ok);
    assert.match(extra.error!, /b: unexpected key/);
    const missing = passes({ a: 1, b: 2 }, { a: 1 });
    assert.ok(!missing.ok);
    assert.match(missing.error!, /b: missing/);
  });

  it('lets "$any" keys be absent', () => {
    assert.ok(passes({ a: 1, b: '$any' }, { a: 1 }).ok);
    assert.ok(passes({ a: 1, b: '$any' }, { a: 1, b: { deep: true } }).ok);
  });

  it('matches arrays in order and by length', () => {
    assert.ok(passes([1, 2], [1, 2]).ok);
    assert.ok(!passes([1, 2], [2, 1]).ok);
    assert.ok(!passes([1], [1, 2]).ok);
  });

  it('matches $unordered as a multiset', () => {
    assert.ok(passes({ $unordered: [1, 2, 2] }, [2, 1, 2]).ok);
    assert.ok(!passes({ $unordered: [1, 2, 2] }, [2, 1, 1]).ok);
    assert.ok(!passes({ $unordered: [1, 2] }, [1, 2, 3]).ok);
  });

  it('supports string tokens', () => {
    assert.ok(passes('$nonempty', 'x').ok);
    assert.ok(!passes('$nonempty', '').ok);
    assert.ok(!passes('$nonempty', 3).ok);
    assert.ok(passes('$prefix:Function execution failed: ', 'Function execution failed: boom').ok);
    assert.ok(!passes('$prefix:abc', 'ab').ok);
    assert.ok(passes('$regex:^\\[\\]\\w+$', '[]EchoItem').ok);
    assert.ok(!passes('$regex:^\\[\\]\\w+$', 'EchoItem').ok);
  });

  it('captures values and exposes them to later siblings', () => {
    const r = passes({ id: '$capture:corr', echo: 'x' }, { id: 'abc', echo: 'x' });
    assert.ok(r.ok);
    assert.deepEqual(r.captures, { corr: 'abc' });
    assert.ok(!passes({ id: '$capture:corr' }, { id: '' }).ok);
  });

  it('commits no captures from a failed match', () => {
    const r = passes({ id: '$capture:corr', echo: 'x' }, { id: 'abc', echo: 'y' });
    assert.ok(!r.ok);
    assert.deepEqual(r.captures, {});
  });

  it('decodes $json strings before matching', () => {
    assert.ok(passes({ $json: { a: '$nonempty' } }, '{"a":"x"}').ok);
    assert.ok(!passes({ $json: { a: 1 } }, '{"a":1,"b":2}').ok);
    assert.ok(!passes({ $json: { a: 1 } }, '{a:1}').ok);
    assert.ok(!passes({ $json: { a: 1 } }, { a: 1 }).ok);
  });

  it('reports the path of the first mismatch', () => {
    const r = passes({ payload: { json: [{ name: 'a' }] } }, { payload: { json: [{ name: 'b' }] } });
    assert.equal(r.error, 'payload.json[0].name: expected "a", got "b"');
  });

  it('substitutes ${vars} in templates and rejects unknown ones', () => {
    assert.deepEqual(substitute({ a: ['${x}-y'], b: 1 }, { x: 'v' }), { a: ['v-y'], b: 1 });
    assert.throws(() => substitute('${nope}', {}), /unknown variable/);
    assert.equal(substitute('$regex:^a$', {}), '$regex:^a$');
  });
});
