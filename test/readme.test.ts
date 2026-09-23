import { describe, it, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { FakeWorkflowServer } from '../conformance/runner/server';

const REPO = path.resolve(__dirname, '..');

/** The first ```typescript block after a heading, verbatim. */
function snippetAfter(heading: string): string {
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const start = readme.indexOf(heading);
  assert.ok(start >= 0, `README has no "${heading}"`);
  const match = /```typescript\n([\s\S]*?)```/.exec(readme.slice(start));
  assert.ok(match, `no typescript block after "${heading}"`);
  return match[1];
}

describe('README', () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  after(async () => {
    for (const c of cleanups.reverse()) await c();
  });

  it('Quick Start runs as written and serves its function', { timeout: 30_000 }, async () => {
    // The only change: the package import points at this repository's source.
    const source = snippetAfter('### Example Usage').replaceAll("'@dibbla/sdk-ts'", JSON.stringify(path.join(REPO, 'src')));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-'));
    const file = path.join(dir, 'quickstart.ts');
    fs.writeFileSync(file, source);
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const server = new FakeWorkflowServer();
    await server.start();
    cleanups.push(() => server.stop());

    const child = spawn(process.execPath, ['--import', require.resolve('tsx'), file], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', GRPC_SERVER_ADDRESS: `127.0.0.1:${server.port}`, SERVER_API_TOKEN: 'readme-token', SDK_LOG_LEVEL: 'warn' },
      stdio: 'pipe',
    });
    let output = '';
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (output += c));
    cleanups.push(() => {
      child.kill('SIGKILL');
    });

    const stream = await server.streams.shift(20_000);
    assert.ok(stream, `the Quick Start never connected:\n${output}`);
    assert.equal(stream.metadata.authorization, 'Bearer readme-token');

    const seen: string[] = [];
    for (;;) {
      const m = await stream.messages.shift(5000);
      assert.ok(m, `registration never completed:\n${output}`);
      seen.push(m.event);
      if (m.event === 'response_list_functions') {
        const names = JSON.parse(m.payload.toString()).map((d: { name: string }) => d.name);
        assert.deepEqual(names, ['greeting']);
        assert.equal(m.server, 'my-custom-worker');
        break;
      }
    }
    assert.equal(seen[0], 'client_registration');

    stream.send({
      function: 'greeting',
      node: 'n',
      workflow: 'wf',
      version: '1.0.0',
      server: '',
      event: 'function_request',
      text: '',
      run: 'r',
      meta: {},
      payload: Buffer.from('{"name":"Ada"}'),
      correlation_id: 'c',
    });
    for (;;) {
      const m = await stream.messages.shift(5000);
      assert.ok(m, `no function_response:\n${output}`);
      if (m.event !== 'function_response') continue;
      assert.equal(m.correlation_id, 'c');
      assert.deepEqual(JSON.parse(m.payload.toString()), { message: 'Hello, Ada!' });
      break;
    }
  });
});
