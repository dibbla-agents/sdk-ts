/**
 * Builds and launches the conformance worker of one SDK as a child process.
 */
import { spawn, execFile, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

const CONFORMANCE_DIR = path.resolve(__dirname, '..');
const REPO_DIR = path.resolve(CONFORMANCE_DIR, '..');

export type WorkerKind = 'go' | 'ts';

export interface WorkerLauncher {
  kind: WorkerKind;
  /** One-time build step before any scenario runs. */
  prepare(): Promise<void>;
  command(): { cmd: string; args: string[] };
  /** Extra environment for the worker process. */
  env?(): Record<string, string>;
}

/**
 * The Go worker, built against the sdk-go version pinned in its go.mod — or,
 * with SDK_GO_DIR set, against a local sdk-go checkout (how sdk-go's own CI
 * runs these fixtures against its HEAD).
 */
class GoWorker implements WorkerLauncher {
  kind: WorkerKind = 'go';
  private binary = '';

  async prepare(): Promise<void> {
    const src = path.join(CONFORMANCE_DIR, 'workers', 'go');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'conformance-go-'));
    this.binary = path.join(out, 'worker');

    const args = ['build', '-o', this.binary];
    const sdkGoDir = process.env.SDK_GO_DIR;
    if (sdkGoDir) {
      // Build against a local checkout without touching the committed go.mod.
      const modfile = path.join(out, 'go.mod');
      fs.copyFileSync(path.join(src, 'go.mod'), modfile);
      fs.copyFileSync(path.join(src, 'go.sum'), path.join(out, 'go.sum'));
      await execFileAsync('go', ['mod', 'edit', '-modfile', modfile, '-replace', `github.com/dibbla-agents/sdk-go=${path.resolve(sdkGoDir)}`], { cwd: src });
      args.push('-modfile', modfile, '-mod=mod');
    }
    args.push('.');
    await execFileAsync('go', args, { cwd: src });
  }

  command() {
    return { cmd: this.binary, args: [] };
  }
}

/**
 * The TypeScript worker. By default it runs against this repository's SDK
 * source. CONFORMANCE_TS_SDK=packed-cjs or packed-esm instead packs the SDK
 * (npm pack of the current build), installs the tarball into a scratch
 * project and loads it through require or import: the package exactly as
 * users get it, exports map and files list included. registry-cjs and
 * registry-esm do the same with the version published on npm
 * (CONFORMANCE_TS_VERSION, default latest).
 */
class TsWorker implements WorkerLauncher {
  kind: WorkerKind = 'ts';
  private loader = '';

  async prepare(): Promise<void> {
    const mode = process.env.CONFORMANCE_TS_SDK ?? 'source';
    if (mode === 'source') return;
    const [origin, format] = mode.split('-');
    if (!['packed', 'registry'].includes(origin) || !['cjs', 'esm'].includes(format)) {
      throw new Error(`CONFORMANCE_TS_SDK=${mode}: want source, packed-cjs, packed-esm, registry-cjs or registry-esm`);
    }
    const project = fs.mkdtempSync(path.join(os.tmpdir(), `conformance-${origin}-`));
    fs.writeFileSync(path.join(project, 'package.json'), '{"name":"conformance-packed","private":true}');
    let spec: string;
    if (origin === 'packed') {
      const { stdout } = await execFileAsync('npm', ['pack', '--silent', '--pack-destination', project], { cwd: REPO_DIR });
      spec = path.join(project, stdout.trim().split('\n').pop()!);
    } else {
      // The published package: CONFORMANCE_TS_VERSION (default: latest).
      spec = `@dibbla/sdk-ts@${process.env.CONFORMANCE_TS_VERSION || 'latest'}`;
    }
    await execFileAsync('npm', ['install', '--silent', '--no-audit', '--no-fund', spec], { cwd: project });
    // Resolved from inside the project, so Node applies the package's exports map.
    fs.writeFileSync(path.join(project, 'load.cjs'), "module.exports = require('@dibbla/sdk-ts');\n");
    fs.writeFileSync(path.join(project, 'load.mjs'), "export * from '@dibbla/sdk-ts';\n");
    this.loader = path.join(project, format === 'cjs' ? 'load.cjs' : 'load.mjs');
  }

  command() {
    return {
      cmd: process.execPath,
      args: ['--import', require.resolve('tsx'), path.join(CONFORMANCE_DIR, 'workers', 'ts', 'worker.ts')],
    };
  }

  env(): Record<string, string> {
    return this.loader ? { CONFORMANCE_SDK_LOADER: this.loader } : {};
  }
}

export function launcherFor(kind: string): WorkerLauncher {
  switch (kind) {
    case 'go':
      return new GoWorker();
    case 'ts':
      return new TsWorker();
    default:
      throw new Error(`unknown worker kind ${JSON.stringify(kind)} (want "go" or "ts")`);
  }
}

/** A running worker process with its combined output kept for diagnostics. */
export class WorkerProcess {
  private child: ChildProcess;
  private output: string[] = [];
  private exited = false;

  constructor(launcher: WorkerLauncher, env: Record<string, string>, cwd: string) {
    const { cmd, args } = launcher.command();
    this.child = spawn(cmd, args, {
      cwd,
      env: {
        // Only what a process needs to run; nothing that could change SDK behaviour.
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? cwd,
        ...launcher.env?.(),
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const keep = (chunk: Buffer) => {
      this.output.push(chunk.toString());
      if (this.output.length > 400) this.output.splice(0, this.output.length - 400);
    };
    this.child.stdout?.on('data', keep);
    this.child.stderr?.on('data', keep);
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      this.output.push(`\n[worker exited: code=${code} signal=${signal}]\n`);
    });
  }

  log(): string {
    return this.output.join('').split('\n').slice(-80).join('\n');
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    const exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(timer);
  }
}

export { REPO_DIR, CONFORMANCE_DIR };
