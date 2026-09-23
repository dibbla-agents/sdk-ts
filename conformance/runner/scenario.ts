/**
 * Scenario loading and execution. See ../README.md for the format.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { FakeWorkflowServer, AcceptedStream, WireMessage } from './server';
import { match, substitute, Vars } from './match';
import { WorkerLauncher, WorkerProcess, CONFORMANCE_DIR } from './worker';

const SCENARIO_DIR = path.join(CONFORMANCE_DIR, 'scenarios');
const DEFAULT_STEP_TIMEOUT_MS = 10_000;

export const WORKER_NAME = 'conformance-worker';
export const WORKER_TOKEN = 'conformance-token';

/** A message the runner sends, or the expectation for one it receives. */
export interface MessageSpec {
  function?: string;
  node?: string;
  workflow?: string;
  version?: string;
  server?: string;
  event?: string;
  text?: string;
  run?: string;
  correlation_id?: string;
  meta?: Record<string, unknown>;
  payload?: { json: unknown } | { text: string } | { base64: string } | null;
}

export type Step =
  | { include: string }
  | { comment: string }
  | { accept: { metadata?: Record<string, string | null> }; timeout_ms?: number }
  | { expect: MessageSpec; timeout_ms?: number }
  | { expect_unordered: MessageSpec[]; timeout_ms?: number }
  | { expect_none: { for_ms: number } }
  | { expect_no_stream: { for_ms: number } }
  | { send: MessageSpec }
  | { end_stream: { code: keyof typeof grpc.status; details?: string } }
  | { write_file: { name: string; content: string } };

export interface Scenario {
  name: string;
  description: string;
  worker?: {
    env?: Record<string, string>;
    unset?: string[];
    files?: Record<string, string>;
  };
  /** Keep ping events instead of silently discarding them. */
  keep_pings?: boolean;
  steps: Step[];
}

export function loadScenarios(): Scenario[] {
  return fs
    .readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const scenario = JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, f), 'utf8')) as Scenario;
      if (scenario.name !== path.basename(f, '.json')) {
        throw new Error(`scenario file ${f} declares name ${JSON.stringify(scenario.name)}; they must agree`);
      }
      return scenario;
    });
}

function expandIncludes(steps: Step[], seen: string[] = []): Step[] {
  return steps.flatMap((step) => {
    if (!('include' in step)) return [expandFragments(step)];
    if (seen.includes(step.include)) throw new Error(`include cycle: ${[...seen, step.include].join(' -> ')}`);
    const file = path.join(SCENARIO_DIR, 'includes', `${step.include}.json`);
    const included = JSON.parse(fs.readFileSync(file, 'utf8')) as Step[];
    return expandIncludes(included, [...seen, step.include]);
  });
}

/** Replaces every {"$fragment": "name"} with the contents of fragments/name.json. */
function expandFragments<T>(value: T): T {
  if (Array.isArray(value)) return value.map(expandFragments) as unknown as T;
  if (typeof value !== 'object' || value === null) return value;
  const obj = value as Record<string, unknown>;
  if (typeof obj.$fragment === 'string' && Object.keys(obj).length === 1) {
    const file = path.join(SCENARIO_DIR, 'fragments', `${obj.$fragment}.json`);
    return expandFragments(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = expandFragments(v);
  return out as T;
}

/** Expected-side view of a received message, in the same shape as MessageSpec. */
function observed(m: WireMessage): Record<string, unknown> {
  let payload: unknown = null;
  if (m.payload.length > 0) {
    const text = m.payload.toString('utf8');
    try {
      payload = { json: JSON.parse(text) };
    } catch {
      payload = { text };
    }
  }
  return {
    function: m.function,
    node: m.node,
    workflow: m.workflow,
    version: m.version,
    server: m.server,
    event: m.event,
    text: m.text,
    run: m.run,
    correlation_id: m.correlation_id,
    meta: m.meta,
    payload,
  };
}

/** A MessageSpec with every omitted field made explicit: omitted means empty. */
function expectation(spec: MessageSpec): Record<string, unknown> {
  let payload: unknown = spec.payload ?? null;
  if (payload && typeof payload === 'object' && 'base64' in payload) {
    payload = { text: Buffer.from((payload as { base64: string }).base64, 'base64').toString('utf8') };
  }
  return {
    function: spec.function ?? '',
    node: spec.node ?? '',
    workflow: spec.workflow ?? '',
    version: spec.version ?? '',
    server: spec.server ?? '',
    event: spec.event ?? '',
    text: spec.text ?? '',
    run: spec.run ?? '',
    correlation_id: spec.correlation_id ?? '',
    meta: spec.meta ?? {},
    payload,
  };
}

function toWire(spec: MessageSpec): WireMessage {
  let payload = Buffer.alloc(0);
  const p = spec.payload;
  if (p && 'json' in p) payload = Buffer.from(JSON.stringify(p.json));
  else if (p && 'text' in p) payload = Buffer.from(p.text);
  else if (p && 'base64' in p) payload = Buffer.from(p.base64, 'base64');
  return {
    function: spec.function ?? '',
    node: spec.node ?? '',
    workflow: spec.workflow ?? '',
    version: spec.version ?? '',
    server: spec.server ?? '',
    event: spec.event ?? '',
    text: spec.text ?? '',
    run: spec.run ?? '',
    meta: spec.meta ?? {},
    payload,
    correlation_id: spec.correlation_id ?? '',
  };
}

function summarize(m: WireMessage): string {
  const s = JSON.stringify(observed(m));
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}

export class ScenarioError extends Error {}

export async function runScenario(scenario: Scenario, launcher: WorkerLauncher): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `conformance-${scenario.name}-`));
  const workdir = path.join(tmp, 'cwd');
  fs.mkdirSync(workdir);
  const vars: Vars = { worker: WORKER_NAME, token: WORKER_TOKEN, tmp };

  for (const [name, content] of Object.entries(scenario.worker?.files ?? {})) {
    fs.writeFileSync(path.join(tmp, name), content);
  }

  const server = new FakeWorkflowServer();
  await server.start();

  const env: Record<string, string> = {
    GRPC_SERVER_ADDRESS: `127.0.0.1:${server.port}`,
    SERVER_NAME: WORKER_NAME,
    SERVER_API_TOKEN: WORKER_TOKEN,
    CONFORMANCE_PING_INTERVAL_SEC: '0',
    ...substitute(scenario.worker?.env ?? {}, vars),
  };
  for (const key of scenario.worker?.unset ?? []) delete env[key];

  const worker = new WorkerProcess(launcher, env, workdir);
  const trail: string[] = [];
  let stream: AcceptedStream | undefined;

  const next = async (timeoutMs: number): Promise<WireMessage | undefined> => {
    if (!stream) throw new ScenarioError('no accepted stream yet (missing "accept" step?)');
    for (;;) {
      const m = await stream.messages.shift(timeoutMs);
      if (m && m.event === 'ping' && !scenario.keep_pings) continue;
      if (m) trail.push(`  <- ${summarize(m)}`);
      return m;
    }
  };

  try {
    const steps = expandIncludes(scenario.steps);
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const where = `step ${i + 1} (${Object.keys(step)[0]})`;

      if ('comment' in step) continue;

      if ('accept' in step) {
        const s = await server.streams.shift(step.timeout_ms ?? DEFAULT_STEP_TIMEOUT_MS);
        if (!s) throw new ScenarioError(`${where}: the worker never opened a stream`);
        stream = s;
        trail.push(`  == stream accepted, metadata ${JSON.stringify(s.metadata)}`);
        for (const [key, want] of Object.entries(substitute(step.accept.metadata ?? {}, vars))) {
          const got = s.metadata[key];
          if (want === null) {
            if (got !== undefined) throw new ScenarioError(`${where}: metadata ${key} should be absent, got ${JSON.stringify(got)}`);
            continue;
          }
          const r = match(want, got, vars, `metadata.${key}`);
          if (!r.ok) throw new ScenarioError(`${where}: ${r.error}`);
          Object.assign(vars, r.captures);
        }
        continue;
      }

      if ('expect' in step) {
        const m = await next(step.timeout_ms ?? DEFAULT_STEP_TIMEOUT_MS);
        if (!m) throw new ScenarioError(`${where}: timed out waiting for ${JSON.stringify(step.expect.event)}`);
        const r = match(substitute(expectation(step.expect), vars), observed(m), vars);
        if (!r.ok) throw new ScenarioError(`${where}: ${r.error}`);
        Object.assign(vars, r.captures);
        continue;
      }

      if ('expect_unordered' in step) {
        const got: WireMessage[] = [];
        for (let n = 0; n < step.expect_unordered.length; n++) {
          const m = await next(step.timeout_ms ?? DEFAULT_STEP_TIMEOUT_MS);
          if (!m) throw new ScenarioError(`${where}: timed out after ${got.length} of ${step.expect_unordered.length} messages`);
          got.push(m);
        }
        const r = match(
          { $unordered: step.expect_unordered.map((e) => substitute(expectation(e), vars)) },
          got.map(observed),
          vars,
        );
        if (!r.ok) throw new ScenarioError(`${where}: ${r.error}`);
        Object.assign(vars, r.captures);
        continue;
      }

      if ('expect_none' in step) {
        const m = await next(step.expect_none.for_ms);
        if (m) throw new ScenarioError(`${where}: expected silence for ${step.expect_none.for_ms}ms, got ${summarize(m)}`);
        continue;
      }

      if ('expect_no_stream' in step) {
        const s = await server.streams.shift(step.expect_no_stream.for_ms);
        if (s) throw new ScenarioError(`${where}: expected no new stream for ${step.expect_no_stream.for_ms}ms, but the worker reconnected`);
        continue;
      }

      if ('send' in step) {
        if (!stream) throw new ScenarioError(`${where}: no accepted stream to send on`);
        const m = toWire(substitute(step.send, vars));
        trail.push(`  -> ${summarize(m)}`);
        stream.send(m);
        continue;
      }

      if ('end_stream' in step) {
        if (!stream) throw new ScenarioError(`${where}: no accepted stream to end`);
        const code = grpc.status[step.end_stream.code];
        if (code === undefined) throw new ScenarioError(`${where}: unknown status ${step.end_stream.code}`);
        trail.push(`  == ending stream with ${step.end_stream.code}`);
        stream.end(code, step.end_stream.details ?? '');
        stream = undefined;
        continue;
      }

      if ('write_file' in step) {
        fs.writeFileSync(path.join(tmp, step.write_file.name), substitute(step.write_file.content, vars));
        continue;
      }

      throw new ScenarioError(`${where}: unknown step ${JSON.stringify(step)}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ScenarioError(
      `${scenario.name}: ${message}\n\nwire trail:\n${trail.slice(-30).join('\n') || '  (nothing)'}\n\nworker output (tail):\n${worker.log()}`,
    );
  } finally {
    await worker.stop();
    await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
