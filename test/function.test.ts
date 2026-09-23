import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { z } from 'zod';
import { newFunction, newSimpleFunction, FunctionCache, GlobalState, InvocationContext } from '../src/function';
import { EventMessage, createEmptyEventMessage } from '../src/types/events';
import { generateHash } from '../src/internal/utils/hash';
import { setLogLevel } from '../src/internal/log';

setLogLevel('silent');

const state: GlobalState = { serverName: 'w', cache: null, store: null, oauth: null, rpc: null };
const event = (meta: Record<string, unknown> | null = null): EventMessage => ({ ...createEmptyEventMessage(), workflow: 'wf', meta });
const json = (v: unknown) => Buffer.from(JSON.stringify(v));

const Text = z.object({ text: z.string() });

class MemoryCache implements FunctionCache {
  entries = new Map<bigint, Buffer>();
  ttls: (number | null)[] = [];
  gets = 0;
  failGet = false;
  async get(key: bigint) {
    this.gets++;
    if (this.failGet) throw new Error('cache down');
    return this.entries.get(key) ?? null;
  }
  async set(key: bigint, value: Buffer) {
    this.entries.set(key, value);
    this.ttls.push(null);
  }
  async setWithTTL(key: bigint, value: Buffer, ttlMs: number) {
    this.entries.set(key, value);
    this.ttls.push(ttlMs);
  }
}

describe('function execution', () => {
  it('decodes the input, runs the handler and encodes the output', async () => {
    const fn = newSimpleFunction({ name: 'up', version: '1.0.0', description: '', input: Text, output: Text, handler: (i) => ({ text: i.text.toUpperCase() }) });
    const out = await fn.execute(json({ text: 'hi', ignored: true }), event(), state);
    assert.equal(out.toString(), '{"text":"HI"}');
  });

  it('reports failures in sdk-go wording', async () => {
    const fail = newSimpleFunction({ name: 'f', version: '1', description: '', input: Text, output: Text, handler: () => { throw new Error('boom'); } });
    await assert.rejects(fail.execute(json({ text: 'x' }), event(), state), { message: 'handler error: boom' });
    await assert.rejects(fail.execute(Buffer.from('{bad'), event(), state), /^Error: failed to unmarshal input: /);
    await assert.rejects(fail.execute(json({ text: 3 }), event(), state), /^Error: failed to unmarshal input: text: /);
    await assert.rejects(fail.execute(null, event(), state), /^Error: failed to unmarshal input: /);
  });

  it('holds the output to its schema, dropping undeclared keys as Go would', async () => {
    const extra = newSimpleFunction({
      name: 'x', version: '1', description: '', input: Text, output: Text,
      handler: (i) => ({ text: i.text, secret: 'not in the schema' }) as unknown as { text: string },
    });
    assert.equal((await extra.execute(json({ text: 'a' }), event(), state)).toString(), '{"text":"a"}');

    const wrong = newSimpleFunction({ name: 'w', version: '1', description: '', input: Text, output: Text, handler: () => ({ text: 5 }) as unknown as { text: string } });
    await assert.rejects(wrong.execute(json({ text: 'a' }), event(), state), /^Error: handler error: output does not match the output schema: text: /);
  });

  it('names the function when it was registered without a handler', async () => {
    const fn = newSimpleFunction({ name: 'forgot', version: '2.0.0', description: '', input: Text, output: Text, handler: undefined as never });
    await assert.rejects(fn.execute(json({ text: 'a' }), event(), state), /forgot.*2\.0\.0.*handler/);
  });

  it('hands simple handlers the verified caller, never one built from inputs', async () => {
    const seen: InvocationContext[] = [];
    const fn = newSimpleFunction({
      name: 'who', version: '1', description: '', input: z.object({ asserted_user_email: z.string().optional() }), output: z.object({}),
      handler: (_i, ctx) => { seen.push(ctx); return {}; },
    });
    await fn.execute(json({ asserted_user_email: 'admin@example.com' }), event({}), state);
    await fn.execute(json({}), event({ asserted_identity: 'user-authenticated', asserted_user_id: 'u', asserted_user_email: 'ada@example.com' }), state);

    const [spoofed, signedIn] = seen;
    assert.equal(spoofed.caller, null);
    assert.equal(spoofed.signal.aborted, false);
    assert.equal(signedIn.caller?.email, 'ada@example.com');
    assert.ok(signedIn.caller?.isUser());
  });

  it('passes event and state to advanced handlers', async () => {
    const fn = newFunction({ name: 'adv', version: '1', description: '', input: Text, output: Text, handler: (_i, ev, st) => ({ text: `${ev.workflow}/${st.serverName}` }) });
    assert.equal((await fn.execute(json({ text: '' }), event(), state)).toString(), '{"text":"wf/w"}');
  });

  describe('caching', () => {
    const cached = (ttl: number, handler = (i: { text: string }) => ({ text: i.text.toUpperCase() })) => {
      const fn = newFunction({ name: 'c', version: '1.0.0', description: '', input: Text, output: Text, handler, cacheTTLMs: ttl });
      const cache = new MemoryCache();
      fn.setCache(cache);
      return { fn, cache };
    };

    it('keys on the payload bytes, name and version, and stores with the TTL', async () => {
      const { fn, cache } = cached(60_000);
      const payload = Buffer.from('{"text":"hello"}');
      await fn.execute(payload, event(), state);
      assert.equal(cache.entries.get(generateHash(payload, 'c', '1.0.0'))?.toString(), '{"text":"HELLO"}');
      assert.deepEqual(cache.ttls, [60_000]);
    });

    it('answers a hit from the cache without running the handler', async () => {
      let runs = 0;
      const { fn, cache } = cached(60_000, (i) => { runs++; return i; });
      const payload = Buffer.from('{"text":"a"}');
      cache.entries.set(generateHash(payload, 'c', '1.0.0'), Buffer.from('{"text":"FROM-CACHE"}'));
      assert.equal((await fn.execute(payload, event(), state)).toString(), '{"text":"FROM-CACHE"}');
      assert.equal(runs, 0);
    });

    it('is off at TTL 0 and uses the server default below 0', async () => {
      const off = cached(0);
      await off.fn.execute(json({ text: 'a' }), event(), state);
      assert.equal(off.cache.gets, 0);

      const serverDefault = cached(-1);
      await serverDefault.fn.execute(json({ text: 'a' }), event(), state);
      assert.deepEqual(serverDefault.cache.ttls, [null]);
    });

    it('treats a failing cache as a miss', async () => {
      const { fn, cache } = cached(60_000);
      cache.failGet = true;
      assert.equal((await fn.execute(json({ text: 'a' }), event(), state)).toString(), '{"text":"A"}');
    });
  });
});
