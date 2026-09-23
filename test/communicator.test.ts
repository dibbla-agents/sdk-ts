import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { FakeWorkflowServer, AcceptedStream } from '../conformance/runner/server';
import {
  GrpcCommunicator,
  GrpcCommunicatorOptions,
  NotConnectedError,
  DEFAULT_KEEPALIVE_TIME_MS,
  DEFAULT_KEEPALIVE_TIMEOUT_MS,
  isNonRetryable,
  jitter,
} from '../src/internal/grpc/communicator';
import { FileTokenProvider } from '../src/internal/grpc/token-provider';
import { setLogLevel } from '../src/internal/log';
import { EventMessage } from '../src/types/events';

setLogLevel('silent');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startServer(): Promise<FakeWorkflowServer> {
  const server = new FakeWorkflowServer();
  await server.start();
  cleanups.push(() => server.stop());
  return server;
}

function communicator(server: FakeWorkflowServer, options: Partial<GrpcCommunicatorOptions> = {}): GrpcCommunicator {
  const comm = new GrpcCommunicator({
    serverAddress: `127.0.0.1:${server.port}`,
    serverName: 'test-server',
    apiToken: 'test-token',
    reconnectIntervalSec: 1,
    healthcheckIntervalSec: 1,
    pingIntervalSec: 0,
    ...options,
  });
  cleanups.push(() => comm.close());
  return comm;
}

/** Accepts streams in the background, running behavior on each, and counts them. */
function serveStreams(server: FakeWorkflowServer, behavior: (s: AcceptedStream, n: number) => Promise<void> | void) {
  const accepted: AcceptedStream[] = [];
  let running = true;
  (async () => {
    while (running) {
      const s = await server.streams.shift(100);
      if (!s) continue;
      accepted.push(s);
      void behavior(s, accepted.length);
    }
  })();
  cleanups.push(async () => {
    running = false;
  });
  return accepted;
}

async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const rejectAfterRegistration = (code: grpc.status) => async (s: AcceptedStream) => {
  await s.messages.shift(5000); // the client_registration
  s.end(code, 'Invalid or expired API token');
};

const event = (name: string): EventMessage => ({
  function: '',
  node: '',
  workflow: '',
  version: '',
  server: 'test-server',
  event: name,
  text: 'x',
  run: '',
  meta: null,
  payload: null,
  correlationId: '',
});

describe('GrpcCommunicator', () => {
  it('opens with client_registration and presents the token and org', async () => {
    const server = await startServer();
    const comm = communicator(server, { orgId: 'org-1' });
    comm.connect();
    const s = await server.streams.shift(5000);
    assert.ok(s);
    assert.equal(s.metadata.authorization, 'Bearer test-token');
    assert.equal(s.metadata['x-org-id'], 'org-1');
    const first = await s.messages.shift(5000);
    assert.equal(first?.event, 'client_registration');
    assert.equal(first?.server, 'test-server');
    assert.equal(first?.text, 'Client registration');
    await comm.waitForConnection(5000);
    assert.ok(comm.isConnected());
  });

  it('does not spin when the stream is rejected as Unauthenticated (DIB-176)', async () => {
    const server = await startServer();
    const streams = serveStreams(server, rejectAfterRegistration(grpc.status.UNAUTHENTICATED));
    const comm = communicator(server);
    comm.connect();
    await comm.waitForConnection(5000);
    await sleep(3000);
    assert.ok(streams.length <= 2, `reconnect spin: ${streams.length} streams in 3s`);
  });

  it('jumps straight to the maximum backoff on an auth failure', async () => {
    const server = await startServer();
    const streams = serveStreams(server, rejectAfterRegistration(grpc.status.UNAUTHENTICATED));
    // The exponential ladder alone would retry within ~1s; the holding
    // pattern waits at least maxBackoff/2 = 5s.
    const comm = communicator(server, { maxBackoffMs: 10_000 });
    comm.connect();
    await comm.waitForConnection(5000);
    await sleep(3000);
    assert.equal(streams.length, 1);
  });

  it('treats PermissionDenied like Unauthenticated', async () => {
    const server = await startServer();
    const streams = serveStreams(server, rejectAfterRegistration(grpc.status.PERMISSION_DENIED));
    const comm = communicator(server, { maxBackoffMs: 10_000 });
    comm.connect();
    await comm.waitForConnection(5000);
    await sleep(2500);
    assert.equal(streams.length, 1);
  });

  it('reconnects after a retryable failure and calls the reconnect hook, not on the first connect', async () => {
    const server = await startServer();
    const streams = serveStreams(server, async (s, n) => {
      await s.messages.shift(5000);
      if (n === 1) s.end(grpc.status.UNAVAILABLE, 'server going away');
    });
    let reconnects = 0;
    const comm = communicator(server);
    comm.setOnReconnect(() => reconnects++);
    comm.connect();
    await comm.waitForConnection(5000);
    await waitFor(() => streams.length >= 2, 5000, 'a reconnect');
    await waitFor(() => reconnects === 1, 2000, 'the reconnect hook');
    await waitFor(() => comm.isConnected(), 2000, 'connected state');
  });

  it('resets the backoff after a healthy connection', async () => {
    const server = await startServer();
    const release: (() => void)[] = [];
    const streams = serveStreams(server, async (s) => {
      await s.messages.shift(5000);
      await new Promise<void>((r) => release.push(r));
      s.end(grpc.status.UNAVAILABLE, 'server going away');
    });
    const comm = communicator(server, { healthyResetAfterMs: 300, maxBackoffMs: 30_000 });
    comm.connect();
    await comm.waitForConnection(5000);
    // Fail fast twice to climb the ladder (1s, then 2s)...
    await waitFor(() => release.length === 1, 2000, 'first stream');
    release[0]();
    await waitFor(() => release.length === 2, 5000, 'second stream');
    // ...then stay healthy past the threshold before dying: the next retry is
    // back at the initial interval, jittered to [0.5s, 1s].
    await sleep(500);
    const before = Date.now();
    release[1]();
    await waitFor(() => streams.length >= 3, 3000, 'a prompt reconnect');
    assert.ok(Date.now() - before < 2000);
  });

  it('keeps a single connection and no stray timers across reconnects', async () => {
    const server = await startServer();
    const release: (() => void)[] = [];
    const streams = serveStreams(server, async (s) => {
      await s.messages.shift(5000);
      await new Promise<void>((r) => release.push(r));
      s.end(grpc.status.UNAVAILABLE, 'server going away');
    });
    // Every stint counts as healthy, so retries stay at the 0.2s interval.
    const comm = communicator(server, { reconnectIntervalSec: 0.2, pingIntervalSec: 1, healthyResetAfterMs: 1 });
    comm.connect();
    await comm.waitForConnection(5000);
    await waitFor(() => release.length === 1, 2000, 'first stream');
    await sleep(100);
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const baseline = timers();

    for (let i = 1; i <= 5; i++) {
      release[i - 1]();
      await waitFor(() => release.length === i + 1, 5000, `stream ${i + 1}`);
      await sleep(50);
    }
    assert.equal(streams.length, 6);
    assert.ok(timers() <= baseline + 1, `timer leak: ${baseline} before, ${timers()} after 5 reconnects`);
  });

  it('closes cleanly while connected and stops reconnecting', async () => {
    const server = await startServer();
    const streams = serveStreams(server, async (s) => {
      await s.messages.shift(5000);
    });
    const comm = communicator(server, { pingIntervalSec: 1 });
    comm.connect();
    await comm.waitForConnection(5000);
    await waitFor(() => streams.length === 1, 5000, 'the server to see the stream');
    const closed = comm.close();
    await Promise.race([closed, sleep(5000).then(() => assert.fail('close() did not return within 5s'))]);
    assert.ok(!comm.isConnected());
    await sleep(1500);
    assert.equal(streams.length, 1);
    await assert.rejects(comm.sendEvent(event('x')), NotConnectedError);
  });

  it('rejects sends while disconnected', async () => {
    const server = await startServer();
    const comm = communicator(server);
    await assert.rejects(comm.sendEvent(event('x')), NotConnectedError);
  });

  it('serializes many concurrent sends onto the stream', async () => {
    const server = await startServer();
    const comm = communicator(server);
    comm.connect();
    const s = await server.streams.shift(5000);
    assert.ok(s);
    await comm.waitForConnection(5000);
    await s.messages.shift(5000); // registration
    await Promise.all(Array.from({ length: 200 }, (_, i) => comm.sendEvent(event(`e${i}`))));
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const m = await s.messages.shift(5000);
      assert.ok(m);
      seen.add(m.event);
    }
    assert.equal(seen.size, 200);
  });

  it('buffers messages that arrive before a handler is attached', async () => {
    const server = await startServer();
    const comm = communicator(server);
    comm.connect();
    const s = await server.streams.shift(5000);
    assert.ok(s);
    await comm.waitForConnection(5000);
    s.send({ ...wire('early-1') });
    s.send({ ...wire('early-2') });
    await sleep(200);
    const got: string[] = [];
    comm.setMessageHandler((m) => got.push(m.event));
    s.send({ ...wire('late') });
    await waitFor(() => got.length === 3, 2000, 'three messages');
    assert.deepEqual(got, ['early-1', 'early-2', 'late']);
  });

  it('keeps a message the server sends the moment the stream opens', async () => {
    const server = await startServer();
    serveStreams(server, (s) => s.send(wire('immediate')));
    const comm = communicator(server);
    const got: string[] = [];
    comm.setMessageHandler((m) => got.push(m.event));
    comm.connect();
    await waitFor(() => got.length === 1, 5000, 'the immediate message');
    assert.deepEqual(got, ['immediate']);
  });

  it('aborts a connection attempt in progress on close()', async () => {
    // A non-routable address: the TCP connect hangs, so the registration
    // write is still waiting for a transport when close() runs.
    const comm = new GrpcCommunicator({ serverAddress: '10.255.255.1:9', serverName: 's' });
    comm.connect();
    await sleep(200);
    const started = Date.now();
    await comm.close();
    assert.ok(Date.now() - started < 2000, `close() took ${Date.now() - started}ms`);
  });

  it('pings on the configured interval', async () => {
    const server = await startServer();
    const comm = communicator(server, { pingIntervalSec: 0.3 });
    comm.connect();
    const s = await server.streams.shift(5000);
    assert.ok(s);
    await s.messages.shift(5000); // registration
    const ping = await s.messages.shift(2000);
    assert.equal(ping?.event, 'ping');
    assert.equal(ping?.text, 'ping');
    assert.equal(ping?.server, 'test-server');
  });

  it('uses 5m/20s keepalive by default, never without a stream, and honours overrides', () => {
    const defaults = new GrpcCommunicator({ serverAddress: 'localhost:1', serverName: 's' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (defaults as any).channelOptions();
    assert.equal(opts['grpc.keepalive_time_ms'], DEFAULT_KEEPALIVE_TIME_MS);
    assert.equal(opts['grpc.keepalive_timeout_ms'], DEFAULT_KEEPALIVE_TIMEOUT_MS);
    assert.equal(opts['grpc.keepalive_permit_without_calls'], 0);
    assert.equal(DEFAULT_KEEPALIVE_TIME_MS, 300_000);
    assert.equal(DEFAULT_KEEPALIVE_TIMEOUT_MS, 20_000);

    const tuned = new GrpcCommunicator({ serverAddress: 'localhost:1', serverName: 's', keepaliveTimeSec: 30, keepaliveTimeoutSec: 10 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tunedOpts = (tuned as any).channelOptions();
    assert.equal(tunedOpts['grpc.keepalive_time_ms'], 30_000);
    assert.equal(tunedOpts['grpc.keepalive_timeout_ms'], 10_000);

    const zero = new GrpcCommunicator({ serverAddress: 'localhost:1', serverName: 's', keepaliveTimeSec: 0, keepaliveTimeoutSec: -5 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const zeroOpts = (zero as any).channelOptions();
    assert.equal(zeroOpts['grpc.keepalive_time_ms'], DEFAULT_KEEPALIVE_TIME_MS);
    assert.equal(zeroOpts['grpc.keepalive_timeout_ms'], DEFAULT_KEEPALIVE_TIMEOUT_MS);
  });

  it('classifies only auth failures as non-retryable, and jitters into [d/2, d]', () => {
    assert.ok(isNonRetryable({ code: grpc.status.UNAUTHENTICATED }));
    assert.ok(isNonRetryable({ code: grpc.status.PERMISSION_DENIED }));
    assert.ok(!isNonRetryable({ code: grpc.status.UNAVAILABLE }));
    assert.ok(!isNonRetryable(new Error('eof')));
    assert.ok(!isNonRetryable(undefined));
    for (let i = 0; i < 1000; i++) {
      const d = jitter(1000);
      assert.ok(d >= 500 && d <= 1000);
    }
  });

  describe('workload identity', () => {
    const tokenFile = (content: string) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-'));
      cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
      const file = path.join(dir, 'token');
      fs.writeFileSync(file, content);
      return file;
    };

    it('presents the rotated token on the next reconnect (DIB-202)', async () => {
      const file = tokenFile('first-token\n');
      const server = await startServer();
      const streams = serveStreams(server, async (s) => {
        await s.messages.shift(5000);
        s.end(grpc.status.UNAVAILABLE, 'server restarting');
      });
      const comm = communicator(server, { apiToken: '', tokenProvider: new FileTokenProvider(file) });
      comm.connect();
      await comm.waitForConnection(5000);
      fs.writeFileSync(file, 'second-token\n');
      await waitFor(() => streams.some((s) => s.metadata.authorization === 'Bearer second-token'), 10_000, 'the rotated token');
      assert.equal(streams[0].metadata.authorization, 'Bearer first-token');
    });

    it('retries promptly after an auth rejection when the token rotated', async () => {
      const file = tokenFile('stale-token');
      const server = await startServer();
      const streams = serveStreams(server, async (s) => {
        await s.messages.shift(5000);
        if (s.metadata.authorization === 'Bearer stale-token') {
          fs.writeFileSync(file, 'fresh-token');
          s.end(grpc.status.UNAUTHENTICATED, 'Invalid or expired API token');
        }
      });
      const comm = communicator(server, { apiToken: '', tokenProvider: new FileTokenProvider(file), maxBackoffMs: 30_000 });
      comm.connect();
      await comm.waitForConnection(5000);
      await waitFor(() => streams.some((s) => s.metadata.authorization === 'Bearer fresh-token'), 5000, 'the fresh token');
    });

    it('holds after an auth rejection when a static token cannot change', async () => {
      const server = await startServer();
      const streams = serveStreams(server, rejectAfterRegistration(grpc.status.UNAUTHENTICATED));
      const comm = communicator(server, { maxBackoffMs: 30_000 });
      comm.connect();
      await comm.waitForConnection(5000);
      await sleep(2500);
      assert.equal(streams.length, 1);
    });

    it('connects without a credential when the token file cannot be read', async () => {
      const server = await startServer();
      const comm = communicator(server, { apiToken: '', tokenProvider: new FileTokenProvider('/nonexistent/token') });
      comm.connect();
      const s = await server.streams.shift(5000);
      assert.ok(s);
      assert.equal(s.metadata.authorization, undefined);
    });
  });
});

function wire(eventName: string) {
  return {
    function: '',
    node: '',
    workflow: 'wf',
    version: '',
    server: '',
    event: eventName,
    text: '',
    run: '',
    meta: {},
    payload: Buffer.alloc(0),
    correlation_id: '',
  };
}
