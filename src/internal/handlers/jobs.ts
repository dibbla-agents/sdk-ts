import { EventMessage, Events } from '../../types/events';
import { JobHandler, JobStatus, newJobEventMeta, parseJobEventMeta } from '../../jobs/types';
import { JobContext } from '../../jobs/context';
import { JobLogger } from '../../jobs/logger';
import { Dispatcher } from '../dispatcher/dispatcher';
import { log, errorMessage } from '../log';
import { EventSender } from './handlers';

interface JobRunnerContext {
  serverName: string;
  communicator: EventSender;
  dispatcher: Dispatcher;
  jobs: JobHandler[];
}

/** The job_registration event announcing every job and its parameters. */
export function jobRegistrationEvent(serverName: string, jobs: JobHandler[]): EventMessage {
  const schemas: Record<string, unknown> = {};
  for (const job of jobs) {
    const parameters: Record<string, unknown> = {};
    for (const p of job.parameters) {
      // A parameter without a default is announced with null, not left out.
      parameters[p.name] = { type: p.type, required: p.required, default: p.default === undefined ? null : p.default };
    }
    schemas[job.id] = { name: job.name, parameters };
  }
  return {
    function: '',
    node: '',
    workflow: '',
    version: '',
    server: serverName,
    event: Events.JobRegistration,
    text: '',
    run: '',
    meta: { host_id: serverName, jobs: schemas },
    payload: null,
    correlationId: '',
  };
}

export async function announceJobs(ctx: Pick<JobRunnerContext, 'serverName' | 'communicator' | 'jobs'>): Promise<void> {
  if (ctx.jobs.length === 0) return;
  try {
    await ctx.communicator.sendEvent(jobRegistrationEvent(ctx.serverName, ctx.jobs));
    log.info(`Registered ${ctx.jobs.length} jobs: ${ctx.jobs.map((j) => j.id).join(', ')}`);
  } catch (err) {
    log.error(`Failed to send job registration: ${errorMessage(err)}`);
  }
}

function lifecycle(ctx: JobRunnerContext, event: string, runId: string, jobId: string, jobName: string, status: string, error?: string): void {
  const meta: Record<string, unknown> = { ...newJobEventMeta(jobId, jobName), status };
  if (error) meta.error = error;
  ctx.communicator
    .sendEvent({
      function: '',
      node: '',
      workflow: '',
      version: '',
      server: ctx.serverName,
      event,
      text: '',
      run: runId,
      meta,
      payload: null,
      correlationId: runId,
    })
    .catch((err) => log.error(`Failed to send ${event} event: ${errorMessage(err)}`));
}

async function executeJob(ctx: JobRunnerContext, runId: string, jobId: string, jobName: string, args: Record<string, unknown>): Promise<void> {
  const job = ctx.jobs.find((j) => j.id === jobId);
  if (!job) {
    log.warn(`Job not found: ${jobId}`);
    lifecycle(ctx, Events.JobFailed, runId, jobId, jobName, JobStatus.Failed, `job not found: ${jobId}`);
    return;
  }
  const name = jobName || job.name;
  const logger = new JobLogger(ctx.communicator, ctx.serverName, runId, jobId, name);
  lifecycle(ctx, Events.JobStarted, runId, jobId, name, JobStatus.InProgress);
  try {
    await job.execute(new JobContext(runId, jobId, name, args, logger));
  } catch (err) {
    log.warn(`Job failed: job_id=${jobId}, run_id=${runId}, error=${errorMessage(err)}`);
    lifecycle(ctx, Events.JobFailed, runId, jobId, name, JobStatus.Failed, errorMessage(err));
    return;
  }
  lifecycle(ctx, Events.JobCompleted, runId, jobId, name, JobStatus.Completed);
  log.info(`Job completed: job_id=${jobId}, run_id=${runId}`);
}

/**
 * Handles job_trigger direct: it only parses the trigger and starts the run,
 * so it never blocks, and triggers never queue behind (or get dropped by) a
 * saturated function pool.
 */
export function registerJobHandlers(ctx: JobRunnerContext): void {
  if (ctx.jobs.length === 0) return;
  ctx.dispatcher.registerDirect(Events.JobTrigger, (message) => {
    const meta = parseJobEventMeta(message.meta);
    log.info(`Received job trigger: job_id=${meta.job_id}, run_id=${message.run}`);

    let args: Record<string, unknown> = {};
    if (message.payload && message.payload.length > 0) {
      try {
        const parsed: unknown = JSON.parse(message.payload.toString('utf8'));
        if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
          throw new Error('job arguments must be a JSON object');
        }
        args = (parsed as Record<string, unknown> | null) ?? {};
      } catch (err) {
        log.warn(`Failed to parse job arguments: ${errorMessage(err)}`);
        lifecycle(ctx, Events.JobFailed, message.run, meta.job_id, meta.job_name, JobStatus.Failed, errorMessage(err));
        return;
      }
    }
    void executeJob(ctx, message.run, meta.job_id, meta.job_name, args);
  });
}
