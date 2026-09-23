import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FileTokenProvider,
  StaticTokenProvider,
  detectFileTokenProvider,
  DEFAULT_IDENTITY_TOKEN_PATH,
  IDENTITY_TOKEN_FILE_ENV,
} from '../src/internal/grpc/token-provider';

const savedEnv = process.env[IDENTITY_TOKEN_FILE_ENV];
afterEach(() => {
  if (savedEnv === undefined) delete process.env[IDENTITY_TOKEN_FILE_ENV];
  else process.env[IDENTITY_TOKEN_FILE_ENV] = savedEnv;
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'token-provider-'));
}

describe('token providers', () => {
  it('reads the file fresh on every call and trims it', async () => {
    const file = path.join(tempDir(), 'token');
    fs.writeFileSync(file, 'tok-1\n');
    const p = new FileTokenProvider(file);
    assert.equal(await p.token(), 'tok-1');
    fs.writeFileSync(file, '  tok-2 \n');
    assert.equal(await p.token(), 'tok-2', 'must not cache');
    assert.equal(p.source(), `identity token file ${file}`);
  });

  it('reports a missing file as an error naming the path', async () => {
    await assert.rejects(new FileTokenProvider('/nonexistent/token').token(), /read identity token \/nonexistent\/token/);
  });

  it('serves a static token', async () => {
    const p = new StaticTokenProvider('ak_123');
    assert.equal(await p.token(), 'ak_123');
    assert.equal(p.source(), 'static api token');
  });

  it('prefers an explicit path, then the environment, then the platform default', () => {
    const dir = tempDir();
    const explicit = path.join(dir, 'explicit');
    const fromEnv = path.join(dir, 'from-env');
    fs.writeFileSync(explicit, 'x');
    fs.writeFileSync(fromEnv, 'x');
    process.env[IDENTITY_TOKEN_FILE_ENV] = fromEnv;

    assert.equal(detectFileTokenProvider(explicit)?.path, explicit);
    assert.equal(detectFileTokenProvider('')?.path, fromEnv);
    assert.equal(detectFileTokenProvider(path.join(dir, 'missing'))?.path, fromEnv, 'a missing explicit path falls through');

    delete process.env[IDENTITY_TOKEN_FILE_ENV];
    const detected = detectFileTokenProvider();
    // The platform mount does not exist on a development machine.
    assert.ok(detected === null || detected.path === DEFAULT_IDENTITY_TOKEN_PATH);
    assert.equal(DEFAULT_IDENTITY_TOKEN_PATH, '/var/run/secrets/dibbla/identity/token');
  });

  it('ignores a directory', () => {
    delete process.env[IDENTITY_TOKEN_FILE_ENV];
    const dir = tempDir();
    const detected = detectFileTokenProvider(dir);
    assert.ok(detected === null || detected.path === DEFAULT_IDENTITY_TOKEN_PATH);
  });
});
