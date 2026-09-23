import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Dispatcher } from '../src/internal/dispatcher/dispatcher';
import { EventMessage, createEmptyEventMessage } from '../src/types/events';
import { setLogLevel } from '../src/internal/log';

setLogLevel('silent');

const msg = (event: string, correlationId = ''): EventMessage => ({ ...createEmptyEventMessage(), event, correlationId });
const tick = () => new Promise((r) => setImmediate(r));

describe('Dispatcher', () => {
  it('runs at most `concurrency` pooled handlers and queues the rest', async () => {
    const d = new Dispatcher(2, 10);
    d.start();
    const release: (() => void)[] = [];
    let running = 0;
    let peak = 0;
    d.register('work', async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((r) => release.push(r));
      running--;
    });
    for (let i = 0; i < 5; i++) assert.ok(d.dispatch(msg('work')));
    await tick();
    assert.equal(running, 2);
    while (release.length) {
      release.shift()!();
      await tick();
      await tick();
    }
    assert.equal(peak, 2);
    assert.equal(running, 0);
  });

  it('runs direct handlers even when every pooled slot is busy (FAT-19)', async () => {
    const d = new Dispatcher(1, 10);
    d.start();
    let respond!: () => void;
    const answered = new Promise<void>((r) => (respond = r));
    let done = false;
    // A pooled handler that waits for a response to its own request.
    d.register('request', async () => {
      await answered;
      done = true;
    });
    d.registerDirect('response', () => respond());
    d.dispatch(msg('request'));
    d.dispatch(msg('response'));
    await tick();
    assert.ok(done, 'the response must reach the waiting handler');
  });

  it('refuses work when the queue is full instead of blocking', () => {
    const d = new Dispatcher(1, 2);
    d.start();
    d.register('work', () => new Promise(() => undefined));
    assert.ok(d.dispatch(msg('work'))); // running
    assert.ok(d.dispatch(msg('work'))); // queued
    assert.ok(d.dispatch(msg('work'))); // queued
    assert.equal(d.dispatch(msg('work')), false);
  });

  it('survives handlers that throw or reject', async () => {
    const d = new Dispatcher(1, 10);
    d.start();
    let after = false;
    d.register('sync-throw', () => { throw new Error('x'); });
    d.register('reject', async () => { throw new Error('y'); });
    d.register('ok', () => { after = true; });
    d.dispatch(msg('sync-throw'));
    d.dispatch(msg('reject'));
    d.dispatch(msg('ok'));
    await tick();
    await tick();
    assert.ok(after);
  });

  it('stop() waits for running handlers', async () => {
    const d = new Dispatcher(2, 10);
    d.start();
    let finished = false;
    d.register('slow', async () => {
      await new Promise((r) => setTimeout(r, 50));
      finished = true;
    });
    d.dispatch(msg('slow'));
    await d.stop();
    assert.ok(finished);
  });
});
