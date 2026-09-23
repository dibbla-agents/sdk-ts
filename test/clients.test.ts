import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { CorrelationRouter, TimeoutError } from '../src/internal/correlation/router';
import { GrpcCacheClient } from '../src/internal/cache/cache-client';
import { GrpcStoreClient } from '../src/internal/store/store-client';
import { GrpcOAuthClient, OAuthError } from '../src/internal/oauth/oauth-client';
import { RpcClient } from '../src/internal/rpc/rpc-client';
import { EventMessage, createEmptyEventMessage } from '../src/types/events';
import { setLogLevel } from '../src/internal/log';

setLogLevel('silent');

/** A communicator whose responder answers each sent request (or not). */
class Loopback {
  sent: EventMessage[] = [];
  fail = false;
  constructor(private respond: (req: EventMessage) => Partial<EventMessage> | null, private deliver: (res: EventMessage) => void = () => undefined) {}
  setDeliver(d: (res: EventMessage) => void) {
    this.deliver = d;
  }
  async sendEvent(e: EventMessage) {
    if (this.fail) throw new Error('not connected to workflow server');
    this.sent.push(e);
    const res = this.respond(e);
    if (res) setImmediate(() => this.deliver({ ...createEmptyEventMessage(), correlationId: e.correlationId, ...res }));
  }
}

describe('correlation router', () => {
  const send = () => Promise.resolve();

  it('resolves with the matching response and forgets the request', async () => {
    const r = new CorrelationRouter();
    const p = r.request('a', send, 'x', { timeoutMs: 1000 });
    assert.equal(r.pending, 1);
    assert.ok(r.deliver('a', { ...createEmptyEventMessage(), text: 'ok' }));
    assert.equal((await p).text, 'ok');
    assert.equal(r.pending, 0);
    assert.equal(r.deliver('a', createEmptyEventMessage()), false, 'a late duplicate is dropped');
  });

  it('times out with a TimeoutError naming what it waited for', async () => {
    const r = new CorrelationRouter();
    await assert.rejects(r.request('a', send, 'store_get_response', { timeoutMs: 20 }), (err: Error) => {
      assert.ok(err instanceof TimeoutError);
      assert.match(err.message, /timed out after 20ms waiting for store_get_response/);
      return true;
    });
    assert.equal(r.pending, 0);
  });

  it('rejects with the abort reason, including when already aborted', async () => {
    const r = new CorrelationRouter();
    const controller = new AbortController();
    const p = r.request('a', send, 'x', { timeoutMs: 0, signal: controller.signal });
    controller.abort(new Error('stop'));
    await assert.rejects(p, /stop/);
    await assert.rejects(r.request('b', send, 'x', { timeoutMs: 0, signal: controller.signal }), /stop/);
    assert.equal(r.pending, 0);
  });

  it('rejects when the request cannot be sent', async () => {
    const r = new CorrelationRouter();
    await assert.rejects(r.request('a', () => Promise.reject(new Error('down')), 'x', { timeoutMs: 1000 }), /down/);
    assert.equal(r.pending, 0);
  });
});

describe('service clients', () => {
  it('cache: a hit returns the bytes; a miss, an empty answer or a timeout is null', async () => {
    const values: Record<string, string> = { hit: 'v' };
    const link = new Loopback((req) =>
      req.meta!.Key === 'slow' ? null : { event: 'cache_get_response', payload: values[req.meta!.Key as string] ? Buffer.from(values[req.meta!.Key as string]) : null },
    );
    const cache = new GrpcCacheClient(link, 'w', 30);
    link.setDeliver((res) => cache.handleResponse(res));
    assert.equal((await cache.getByString('hit'))?.toString(), 'v');
    assert.equal(await cache.getByString('miss'), null);
    assert.equal(await cache.getByString('slow'), null);
    link.fail = true;
    await assert.rejects(cache.getByString('hit'), /not connected/);
  });

  it('cache: sets carry the key, TTL in whole seconds and calling server', async () => {
    const link = new Loopback(() => null);
    const cache = new GrpcCacheClient(link, 'w');
    await cache.setWithTTL(42n, Buffer.from('x'), 1999);
    assert.deepEqual(link.sent[0].meta, { Key: '42', TTL: 1, calling_server: 'w' });
    assert.equal(link.sent[0].event, 'cache_set');
    assert.match(link.sent[0].correlationId, /^[0-9a-f]{8}-[0-9a-f]{8}$/);
  });

  it('store: a timeout throws rather than reading as empty', async () => {
    const link = new Loopback((req) => (req.meta!.Key === 'slow' ? null : { event: 'store_get_response', payload: req.meta!.Key === 'k' ? Buffer.from('v') : null }));
    const store = new GrpcStoreClient(link, 'w', 30);
    link.setDeliver((res) => store.handleResponse(res));
    assert.equal(await store.getString('wf', 'k'), 'v');
    assert.equal(await store.get('wf', 'none'), null);
    await assert.rejects(store.get('wf', 'slow'), TimeoutError);
  });

  it('oauth: maps tokens, raises oauth_error as OAuthError, and propagates failures', async () => {
    const link = new Loopback((req) => {
      const run = JSON.parse(req.payload!.toString()).run_id;
      if (run === 'denied') return { event: 'oauth_error', payload: Buffer.from('{"error":"not_connected","error_message":"Google is not connected"}') };
      if (req.event === 'oauth_status_request') return run === 'slow' ? null : { event: 'oauth_status_response', payload: Buffer.from('{"google":{"connected":true,"email":"a@b","last_used":null,"scopes":"s"}}') };
      return { event: 'oauth_token_response', payload: Buffer.from('{"access_token":"t","token_type":"Bearer","expires_at":1,"provider":"google"}') };
    });
    const oauth = new GrpcOAuthClient(link, 'w', 30);
    link.setDeliver((res) => oauth.handleResponse(res));

    assert.deepEqual(await oauth.getAccessToken('google', 'r'), { accessToken: 't', tokenType: 'Bearer', expiresAt: 1, provider: 'google' });
    await assert.rejects(oauth.getAccessToken('google', 'denied'), (err: Error) => {
      assert.ok(err instanceof OAuthError);
      assert.equal(err.message, 'oauth error [not_connected]: Google is not connected');
      return true;
    });
    assert.deepEqual(await oauth.getConnectedProviders('r'), { google: { connected: true, email: 'a@b', lastUsed: null, scopes: 's' } });
    assert.equal(await oauth.isProviderConnected('google', 'r'), true);
    assert.equal(await oauth.isProviderConnected('github', 'r'), false);
    await assert.rejects(oauth.isProviderConnected('google', 'slow'), TimeoutError, 'failure is not "not connected"');
  });

  it('rpc: calls another function and resolves with its response payload', async () => {
    const link = new Loopback((req) => (req.event === 'function_request' ? { event: 'function_response', payload: Buffer.from('{"text":"pong"}') } : null));
    const rpc = new RpcClient(link, 'w');
    link.setDeliver((res) => rpc.handleCallResponse(res));
    const caller = { ...createEmptyEventMessage(), server: 'engine', workflow: 'wf', run: 'r' };
    const out = await rpc.call(1, { id: 'n', type: 'function', data: { function: { name: 'echo', version: '1', server: 'other' } } }, caller, { text: 'ping' });
    assert.equal(out.toString(), '{"text":"pong"}');
    const req = link.sent[0];
    assert.deepEqual([req.function, req.server, req.node, req.workflow, req.run, req.meta], ['echo', 'other', 'n', 'wf', 'r', { calling_server: 'engine' }]);
  });
});

describe('correlation router: zero timeout', () => {
  it('expires at once, like a Go context with a zero deadline', async () => {
    const r = new CorrelationRouter();
    await assert.rejects(r.request('a', () => Promise.resolve(), 'x', { timeoutMs: 0 }), TimeoutError);
    assert.equal(r.pending, 0);
  });
});
