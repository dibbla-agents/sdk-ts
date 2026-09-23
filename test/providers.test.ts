import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { toolSearchProvider, memoryProvider, Turn } from '../src/providers';
import { CapabilityRegistry, registerCapabilityHandlers } from '../src/internal/handlers/capability';
import { Dispatcher } from '../src/internal/dispatcher/dispatcher';
import { EventMessage, createEmptyEventMessage } from '../src/types/events';
import { setLogLevel } from '../src/internal/log';

setLogLevel('silent');

const settle = () => new Promise((r) => setTimeout(r, 20));

function harness(providers: ReturnType<typeof toolSearchProvider>[], concurrency = 8) {
  const sent: EventMessage[] = [];
  const capabilities = new CapabilityRegistry();
  for (const p of providers) capabilities.add(p);
  const dispatcher = new Dispatcher(concurrency, 100);
  dispatcher.start();
  registerCapabilityHandlers({
    serverName: 'w',
    communicator: { sendEvent: async (e) => void sent.push(e), setMessageHandler: () => undefined },
    dispatcher,
    capabilities,
  });
  const request = (correlationId: string, payload: unknown) =>
    dispatcher.dispatch({
      ...createEmptyEventMessage(),
      event: 'capability_provider_request',
      correlationId,
      payload: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)),
    });
  const cancel = (correlationId: string) => dispatcher.dispatch({ ...createEmptyEventMessage(), event: 'capability_provider_cancel', correlationId });
  const responses = () => Object.fromEntries(sent.map((e) => [e.correlationId, JSON.parse(e.payload!.toString())]));
  return { sent, request, cancel, responses, capabilities };
}

const reverse = toolSearchProvider({
  name: 'rev',
  description: 'd',
  version: '1.0',
  select: (query, stubs) => {
    if (query === 'error') throw new Error('kaboom');
    return stubs.map((s) => s.name).reverse();
  },
});

describe('capability providers', () => {
  it('refuses definitions the workflow server would skip', () => {
    const r = new CapabilityRegistry();
    r.add(toolSearchProvider({ name: 'acme-scorer', description: '', version: '1.0', wantsCatalogSync: true }));
    r.add(memoryProvider({ name: 'acme-vector', description: '', version: '1.0' }));
    assert.throws(() => r.add(toolSearchProvider({ name: 'bad:name', description: '', version: '1' })), /must not contain/);
    assert.throws(() => r.add(toolSearchProvider({ name: 'bad/name', description: '', version: '1' })), /must not contain/);
    assert.throws(() => r.add(toolSearchProvider({ name: '', description: '', version: '1' })), /must not be empty/);
    assert.throws(() => r.add(toolSearchProvider({ name: 'acme-scorer', description: '', version: '1' })), /already registered/);
    // The same name on another seat is fine.
    r.add(memoryProvider({ name: 'acme-scorer', description: '', version: '1' }));
    assert.equal(r.size, 3);
  });

  it('requires the struct-shaped handler when extra ports are declared (DIB-449)', () => {
    const r = new CapabilityRegistry();
    const ports = { extraInputsSchema: { type: 'object', properties: { p: { type: 'string' } } } };
    assert.throws(() => r.add(toolSearchProvider({ name: 't', description: '', version: '1', select: () => [], ...ports })), /selectFull/);
    assert.throws(
      () => r.add(memoryProvider({ name: 'm', description: '', version: '1', transform: () => [], ...ports })),
      /transformFull/,
    );
    // Binding-only providers with ports are allowed.
    r.add(toolSearchProvider({ name: 'bind-only', description: '', version: '1', ...ports }));
  });

  it('pins the registration wire format', () => {
    const r = new CapabilityRegistry();
    r.add(toolSearchProvider({ name: 'acme', description: 'd', version: '1.2', wantsCatalogSync: true, extraInputsSchema: { type: 'object' } }));
    r.add(memoryProvider({ name: 'm', description: 'd', version: '1', maxHistoryFraction: 0.5 }));
    assert.deepEqual(JSON.parse(JSON.stringify(r.definitions('worker-1'))), [
      { capability: 'tool_search', name: 'acme', description: 'd', version: '1.2', contract_version: 1, extra_inputs_schema: { type: 'object' }, wants_catalog_sync: true, server: 'worker-1' },
      { capability: 'memory', name: 'm', description: 'd', version: '1', contract_version: 1, wants_catalog_sync: false, max_history_fraction: 0.5, server: 'worker-1' },
    ]);
  });

  it('round-trips a select, encoding errors and empty selections like sdk-go', async () => {
    const h = harness([reverse]);
    h.request('c1', { capability: 'tool_search', provider: 'rev', query: 'q', stubs: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], top_n: 5 });
    h.request('c2', { capability: 'tool_search', provider: 'rev', query: 'error', stubs: [] });
    h.request('c3', { capability: 'tool_search', provider: 'rev', query: 'q', stubs: [] });
    await settle();
    assert.deepEqual(h.responses(), { c1: { selected: ['c', 'b', 'a'] }, c2: { error: 'kaboom' }, c3: {} });
    for (const e of h.sent) {
      assert.equal(e.event, 'capability_provider_response');
      assert.equal(e.server, '');
      assert.equal(e.text, '');
    }
  });

  it('answers unknown providers and garbage payloads with an error, not silence', async () => {
    const h = harness([reverse, toolSearchProvider({ name: 'inert', description: '', version: '1' })]);
    h.request('c1', { capability: 'tool_search', provider: 'inert' });
    h.request('c2', { capability: 'memory', provider: 'rev' });
    h.request('c3', '{nope');
    await settle();
    const r = h.responses();
    assert.equal(r.c1.error, 'capability provider "inert" for capability "tool_search" is not implemented by this server');
    assert.equal(r.c2.error, 'capability provider "rev" for capability "memory" is not implemented by this server');
    assert.match(r.c3.error, /^capability provider request payload is not valid JSON: /);
  });

  it('passes memory turns and thread meta through unchanged', async () => {
    const turn: Turn = {
      id: 't1',
      role: 'assistant',
      date: '2026-09-20T10:00:05.5Z',
      parts: [{ type: 'tool_call', tool_call: { tool_name: 'search', args: { q: 'x' }, result: [1, { two: 2 }] } }],
    };
    let seenUser: string | null | undefined;
    const echo = memoryProvider({
      name: 'echo',
      description: '',
      version: '1',
      transformFull: (req) => {
        seenUser = req.meta.user_id;
        return { turns: req.turns, extraOutputs: {} };
      },
    });
    const h = harness([echo]);
    h.request('c1', { capability: 'memory', provider: 'echo', turns: [turn], current_message: 'm', token_budget: 10, thread_meta: { thread_id: 't', turn_count: 1, user_id: null } });
    await settle();
    assert.deepEqual(h.responses().c1, { turns: [turn] });
    assert.equal(seenUser, null);
  });

  it('aborts the handler when the engine cancels the call (DIB-443)', async () => {
    let reason: unknown;
    const blocking = memoryProvider({
      name: 'block',
      description: '',
      version: '1',
      transform: (_m, _t, _b, _meta, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => {
            reason = signal.reason;
            reject(new Error('stopped'));
          }),
        ),
    });
    const h = harness([blocking]);
    h.request('c1', { capability: 'memory', provider: 'block' });
    await settle();
    assert.equal(h.sent.length, 0);
    h.cancel('c1');
    await settle();
    assert.ok(reason instanceof Error);
    assert.deepEqual(h.responses().c1, { error: 'stopped' });
  });

  it('skips a queued request whose cancel overtook it', async () => {
    const releases: (() => void)[] = [];
    const slow = toolSearchProvider({
      name: 'slow',
      description: '',
      version: '1',
      selectFull: () => new Promise((resolve) => releases.push(() => resolve({ selected: ['x'] }))),
    });
    const h = harness([slow], 1);
    h.request('busy', { capability: 'tool_search', provider: 'slow' });
    h.request('queued', { capability: 'tool_search', provider: 'slow' });
    h.cancel('queued'); // direct: arrives before the queued request runs
    await settle();
    releases.shift()!();
    await settle();
    assert.deepEqual(Object.keys(h.responses()), ['busy']);
    assert.equal(releases.length, 0, 'the abandoned request never ran');
  });

  it('bounds the tombstones left by cancels whose requests never arrive', () => {
    const r = new CapabilityRegistry();
    for (let i = 0; i < 1500; i++) r.cancel(`never-${i}`);
    // The oldest were evicted, the newest are still honoured.
    assert.ok(r.begin('never-0') !== null);
    assert.equal(r.begin('never-1499'), null);
  });
});
