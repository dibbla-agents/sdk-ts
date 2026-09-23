/**
 * Runs every scenario against one SDK's conformance worker.
 *
 *   CONFORMANCE_WORKER=ts  (default) this repository's SDK
 *   CONFORMANCE_WORKER=go  sdk-go, as pinned in workers/go/go.mod
 *                          (or SDK_GO_DIR=<checkout> for a local sdk-go)
 *   CONFORMANCE_ONLY=a,b   run only the named scenarios
 *
 * The go worker must pass everything: the scenarios describe sdk-go's
 * behaviour, and a scenario Go fails is a wrong scenario. Known TypeScript
 * gaps are listed in known-gaps.json; a listed scenario that starts passing
 * fails the run so the list cannot go stale.
 */
import { describe, it, before } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadScenarios, runScenario } from './runner/scenario';
import { launcherFor } from './runner/worker';

const kind = process.env.CONFORMANCE_WORKER ?? 'ts';
const only = process.env.CONFORMANCE_ONLY?.split(',').filter(Boolean);
const launcher = launcherFor(kind);

const gapsFile = JSON.parse(fs.readFileSync(path.join(__dirname, 'known-gaps.json'), 'utf8')) as Record<
  string,
  Record<string, string>
>;
const gaps = gapsFile[kind] ?? {};

const scenarios = loadScenarios().filter((s) => !only || only.includes(s.name));

for (const name of Object.keys(gaps)) {
  if (!scenarios.some((s) => s.name === name) && !only) {
    throw new Error(`known-gaps.json lists ${JSON.stringify(name)} for ${kind}, but no such scenario exists`);
  }
}

describe(`conformance: ${kind} worker`, { concurrency: 6 }, () => {
  before(() => launcher.prepare(), { timeout: 300_000 });

  for (const scenario of scenarios) {
    const gap = gaps[scenario.name];
    it(scenario.name, { timeout: 120_000 }, async (t) => {
      let failure: unknown;
      try {
        await runScenario(scenario, launcher);
      } catch (err) {
        failure = err;
      }
      if (gap) {
        if (!failure) {
          throw new Error(`${scenario.name} passes now: remove it from known-gaps.json (${kind}: ${gap})`);
        }
        t.todo(`known gap: ${gap}`);
        return;
      }
      if (failure) throw failure;
    });
  }
});
