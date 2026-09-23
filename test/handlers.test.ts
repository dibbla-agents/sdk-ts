import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { z } from 'zod';
import { registerHandlers, startMessageListener, HandlerContext, EventSender } from '../src/internal/handlers/handlers';
import { Dispatcher } from '../src/internal/dispatcher/dispatcher';
import { GrpcCacheClient } from '../src/internal/cache/cache-client';
import { GrpcStoreClient } from '../src/internal/store/store-client';
import { GrpcOAuthClient } from '../src/internal/oauth/oauth-client';
import { RpcClient } from '../src/internal/rpc/rpc-client';
import { CapabilityRegistry } from '../src/internal/handlers/capability';
import { newSimpleFunction, WorkerFunction } from '../src/function';
import { functionKey } from '../src/types/keys';
import { EventMessage, createEmptyEventMessage } from '../src/types/events';
import { setLogLevel } from '../src/internal/log';

setLogLevel('silent');

class FakeSender implements EventSender {
  sent: EventMessage[] = [];
  handler: ((m: EventMessage) => void) | null = null;
  async sendEvent(event: EventMessage) {
    this.sent.push(event);
  }
  isConnected() {
    return true;
  }
  setMessageHandler(handler: (m: EventMessage) => void) {
    this.handler = handler;
  }
  deliver(fields: Partial<EventMessage>) {
    this.handler!({ ...createEmptyEventMessage(), ...fields });
  }
}

const settle = () => new Promise((r) => setTimeout(r, 20));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFunction = WorkerFunction<any, any>;

function setup(fns: AnyFunction[], concurrency = 8, queue = 100) {
  const sender = new FakeSender();
  const functions = new Map<string, AnyFunction>();
  for (const fn of fns) {
    fn.setServer('w');
    functions.set(functionKey('w', fn.name, fn.version), fn);
  }
  const dispatcher = new Dispatcher(concurrency, queue);
  dispatcher.start();
  const ctx: HandlerContext = {
    serverName: 'w',
    communicator: sender,
    dispatcher,
    functions,
    cacheClient: new GrpcCacheClient(sender, 'w'),
    storeClient: new GrpcStoreClient(sender, 'w'),
    oauthClient: new GrpcOAuthClient(sender, 'w'),
    rpcClient: new RpcClient(sender, 'w'),
    globalState: { serverName: 'w', cache: null, store: null, oauth: null, rpc: null },
    capabilities: new CapabilityRegistry(),
  };
  registerHandlers(ctx);
  startMessageListener(ctx);
  return sender;
}

const Text = z.object({ text: z.string() });
const echo = newSimpleFunction({ name: 'echo', version: '1.0.0', description: '', input: Text, output: Text, handler: (i) => i });
const request = (fields: Partial<EventMessage> = {}): Partial<EventMessage> => ({
  event: 'function_request',
  function: 'echo',
  version: '1.0.0',
  server: 'engine',
  node: 'n',
  workflow: 'wf',
  run: 'r',
  correlationId: 'c',
  payload: Buffer.from('{"text":"hi"}'),
  ...fields,
});

describe('inbound handlers', () => {
  it('answers a function request with the invocation fields and no server or text', async () => {
    const sender = setup([echo]);
    sender.deliver(request());
    await settle();
    assert.equal(sender.sent.length, 1);
    const { payload, ...rest } = sender.sent[0];
    assert.equal(payload?.toString(), '{"text":"hi"}');
    assert.deepEqual(rest, {
      function: 'echo', node: 'n', workflow: 'wf', version: '1.0.0', server: '', event: 'function_response',
      text: '', run: 'r', meta: null, correlationId: 'c',
    });
  });

  it('reports unknown functions and failures as error events', async () => {
    const sender = setup([echo]);
    sender.deliver(request({ function: 'missing', correlationId: 'c1' }));
    sender.deliver(request({ payload: Buffer.from('{bad'), correlationId: 'c2' }));
    await settle();
    const byCorrelation = Object.fromEntries(sender.sent.map((m) => [m.correlationId, m]));
    assert.equal(byCorrelation.c1.event, 'error');
    assert.equal(byCorrelation.c1.text, 'Function not found');
    assert.equal(byCorrelation.c1.server, '');
    assert.match(byCorrelation.c2.text, /^Function execution failed: failed to unmarshal input: /);
  });

  it('drops function requests without a workflow', async () => {
    const sender = setup([echo]);
    sender.deliver(request({ workflow: '' }));
    await settle();
    assert.equal(sender.sent.length, 0);
  });

  it('fails a request fast when the pool queue is full', async () => {
    const blocked = newSimpleFunction({ name: 'block', version: '1', description: '', input: Text, output: Text, handler: () => new Promise<never>(() => undefined) });
    const sender = setup([blocked], 1, 1);
    sender.deliver(request({ function: 'block', version: '1', correlationId: 'running' }));
    sender.deliver(request({ function: 'block', version: '1', correlationId: 'queued' }));
    sender.deliver(request({ function: 'block', version: '1', correlationId: 'rejected' }));
    await settle();
    assert.equal(sender.sent.length, 1);
    assert.equal(sender.sent[0].correlationId, 'rejected');
    assert.equal(sender.sent[0].event, 'error');
    assert.equal(sender.sent[0].text, 'Worker overloaded: dispatcher queue full, request dropped');
  });

  it('answers discovery without a workflow', async () => {
    const sender = setup([echo]);
    sender.deliver({ event: 'request_server_info', correlationId: 'i' });
    await settle();
    assert.deepEqual(
      sender.sent.map((m) => [m.event, m.server, m.text, m.correlationId]),
      [
        ['response_server_name', 'w', 'w', 'i'],
        ['response_list_functions', 'w', 'List of functions', 'i'],
      ],
    );
    assert.equal(JSON.parse(sender.sent[1].payload!.toString())[0].name, 'echo');
  });

  it('ignores pongs', async () => {
    const sender = setup([echo]);
    sender.deliver({ event: 'pong', text: 'pong' });
    await settle();
    assert.equal(sender.sent.length, 0);
  });
});
