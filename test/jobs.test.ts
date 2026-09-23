import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Dispatcher } from '../src/internal/dispatcher/dispatcher';
import { jobRegistrationEvent, registerJobHandlers } from '../src/internal/handlers/jobs';
import { JobContext, JobLogger, newJob, originHeaders, parseJobEventMeta, generateRunId, generateJobRunId, JobHandler } from '../src/jobs';
import { EventMessage, createEmptyEventMessage } from '../src/types/events';
import { setLogLevel } from '../src/internal/log';

setLogLevel('silent');

class Sink {
  sent: EventMessage[] = [];
  async sendEvent(e: EventMessage) {
    this.sent.push(e);
  }
  setMessageHandler() {}
}

const quiet = { write: () => true, isTTY: false };
const settle = () => new Promise((r) => setTimeout(r, 20));

function runner(jobs: JobHandler[]) {
  const sink = new Sink();
  const dispatcher = new Dispatcher();
  dispatcher.start();
  registerJobHandlers({ serverName: 'w', communicator: sink, dispatcher, jobs });
  const trigger = (fields: Partial<EventMessage>) => dispatcher.dispatch({ ...createEmptyEventMessage(), event: 'job_trigger', ...fields });
  return { sink, trigger };
}

/** Event name, text and meta without the timestamp, for comparison. */
const shape = (e: EventMessage) => {
  const { timestamp, ...meta } = e.meta as Record<string, unknown>;
  assert.match(String(timestamp), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(e.server, 'w');
  assert.equal(e.correlationId, e.run);
  return [e.event, e.text, meta];
};

const counting = newJob({
  id: 'count_job',
  name: 'Count Job',
  parameters: [
    { name: 'limit', type: 'int', required: true },
    { name: 'label', type: 'string', required: false, default: 'items' },
  ],
  execute(ctx) {
    ctx.logger.withWriter(quiet);
    ctx.logger.info('starting');
    if (ctx.getBoolArg('fail', false)) throw new Error('count failed');
    ctx.logger.taskStarted('count');
    ctx.logger.progress(1, 1, `counting ${ctx.getStringArg('label', 'items')}`);
    ctx.logger.taskCompleted();
  },
});

describe('jobs', () => {
  it('announces jobs with their parameters, a missing default as null', () => {
    const e = jobRegistrationEvent('w', [counting]);
    assert.equal(e.event, 'job_registration');
    assert.equal(e.server, 'w');
    assert.deepEqual(e.meta, {
      host_id: 'w',
      jobs: {
        count_job: {
          name: 'Count Job',
          parameters: {
            limit: { type: 'int', required: true, default: null },
            label: { type: 'string', required: false, default: 'items' },
          },
        },
      },
    });
  });

  it('runs a triggered job and reports its lifecycle, logs, tasks and progress', async () => {
    const { sink, trigger } = runner([counting]);
    trigger({ run: 'run-1', meta: { job_id: 'count_job' }, payload: Buffer.from('{"label":"rows"}') });
    await settle();
    const base = { job_id: 'count_job', job_name: 'Count Job' };
    assert.deepEqual(sink.sent.map(shape), [
      ['job_started', '', { ...base, status: 'in_progress' }],
      ['log_message', 'starting', { ...base, log_level: 'info' }],
      ['task_started', '', { ...base, status: 'in_progress', task_name: 'count' }],
      ['progress_update', 'counting rows', { ...base, task_name: 'count', progress_current: 1, progress_total: 1 }],
      ['task_completed', '', { ...base, status: 'completed', task_name: 'count' }],
      ['job_completed', '', { ...base, status: 'completed' }],
    ]);
  });

  it('reports failed, unknown and malformed runs as job_failed', async () => {
    const { sink, trigger } = runner([counting]);
    trigger({ run: 'r-fail', meta: { job_id: 'count_job', job_name: 'Count Job' }, payload: Buffer.from('{"fail":true}') });
    trigger({ run: 'r-unknown', meta: { job_id: 'nope' } });
    trigger({ run: 'r-bad', meta: { job_id: 'count_job', job_name: 'Count Job' }, payload: Buffer.from('{bad') });
    trigger({ run: 'r-array', meta: { job_id: 'count_job', job_name: 'Count Job' }, payload: Buffer.from('[1]') });
    await settle();
    const failed = Object.fromEntries(sink.sent.filter((e) => e.event === 'job_failed').map((e) => [e.run, e.meta as Record<string, unknown>]));
    assert.equal(failed['r-fail'].error, 'count failed');
    assert.equal(failed['r-fail'].status, 'failed');
    assert.equal(failed['r-unknown'].error, 'job not found: nope');
    assert.equal(failed['r-unknown'].job_name, '');
    assert.ok(failed['r-bad'].error);
    assert.equal(failed['r-array'].error, 'job arguments must be a JSON object');
  });

  it('reads arguments leniently, like sdk-go', () => {
    const ctx = new JobContext('r', 'j', 'J', { n: 2.9, s: 'x', b: true, f: 1.5, str: '3' }, new JobLogger(new Sink(), 'w', 'r', 'j', 'J'));
    assert.equal(ctx.getIntArg('n', 0), 2);
    assert.equal(ctx.getIntArg('str', 7), 7);
    assert.equal(ctx.getIntArg('missing', 7), 7);
    assert.equal(ctx.getStringArg('s', ''), 'x');
    assert.equal(ctx.getStringArg('n', 'd'), 'd');
    assert.equal(ctx.getBoolArg('b', false), true);
    assert.equal(ctx.getNumberArg('f', 0), 1.5);
  });

  it('sends task failures and skips with their details', async () => {
    const sink = new Sink();
    const logger = new JobLogger(sink, 'w', 'r', 'j', 'J').withWriter(quiet);
    logger.taskStarted('t');
    logger.taskFailed(new Error('nope'));
    logger.taskSkipped('not needed');
    logger.progressIndeterminate(5, 'scanning');
    await settle();
    const [, failed, skipped, progress] = sink.sent;
    assert.deepEqual([failed.event, (failed.meta as Record<string, unknown>).error], ['task_failed', 'nope']);
    assert.deepEqual([skipped.event, skipped.text, (skipped.meta as Record<string, unknown>).status], ['task_skipped', 'not needed', 'skipped']);
    assert.deepEqual([(progress.meta as Record<string, unknown>).progress_current, (progress.meta as Record<string, unknown>).progress_total], [5, 0]);
  });

  it('parses job meta leniently', () => {
    assert.deepEqual(parseJobEventMeta({ job_id: 'j', job_name: 5, progress_current: 2, progress_total: 3 }), {
      job_id: 'j', job_name: '', timestamp: '', progress_current: 2, progress_total: 3,
    });
    assert.deepEqual(parseJobEventMeta(null), { job_id: '', job_name: '', timestamp: '' });
  });

  it('generates run ids in sdk-go format', () => {
    assert.match(generateRunId(), /^run_\d{8}_\d{6}_[0-9a-f]{4}$/);
    assert.match(generateJobRunId('sync'), /^sync_run_\d{8}_\d{6}_[0-9a-f]{4}$/);
  });

  describe('run origin headers (DIB-256)', () => {
    const ctx = (runId: string, task = '') =>
      new JobContext(runId, 'j', 'J', {}, new JobLogger(new Sink(), 'w', runId, 'j', 'J', task));

    it('stamps the run id and current task', () => {
      assert.deepEqual(originHeaders(ctx('pipeline-1-123', 'GenerateSentiment')), {
        'X-Dibbla-Origin-Kind': 'pipeline_task',
        'X-Dibbla-Origin-Id': 'pipeline-1-123',
        'X-Dibbla-Origin-Label': 'GenerateSentiment',
      });
    });

    it('omits the label when there is no task, or it is too long', () => {
      assert.deepEqual(Object.keys(originHeaders(ctx('r'))), ['X-Dibbla-Origin-Kind', 'X-Dibbla-Origin-Id']);
      assert.ok(!('X-Dibbla-Origin-Label' in originHeaders(ctx('r', 'x'.repeat(257)))));
      assert.ok('X-Dibbla-Origin-Label' in originHeaders(ctx('r', 'x'.repeat(256))));
    });

    it('stamps nothing without a usable run id', () => {
      assert.deepEqual(originHeaders(null), {});
      assert.deepEqual(originHeaders(ctx('')), {});
      assert.deepEqual(originHeaders(ctx('x'.repeat(257))), {});
    });
  });
});
