import type { JobContext } from './context';

/** The status of a job or task, as reported in job event meta. */
export const JobStatus = {
  Pending: 'pending',
  InProgress: 'in_progress',
  Completed: 'completed',
  Failed: 'failed',
  Skipped: 'skipped',
} as const;

export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

/** A parameter a job accepts, announced to the workflow server. */
export interface JobParameter {
  name: string;
  /** A type name such as "string", "int", "bool", "float64". */
  type: string;
  required: boolean;
  /** Sent as null when absent. */
  default?: unknown;
}

/**
 * A long-running job the workflow server can trigger. Register it with
 * server.registerJob(); the server announces it on connect and runs
 * execute() for every job_trigger naming its id.
 */
export interface JobHandler {
  /** Unique id the server triggers the job by. */
  id: string;
  /** Human-readable name. */
  name: string;
  parameters: JobParameter[];
  /** Runs the job. Throwing (or rejecting) fails it with the error's message. */
  execute(ctx: JobContext): void | Promise<void>;
}

/** Options for newJob(). */
export interface JobOptions {
  id: string;
  name: string;
  parameters?: JobParameter[];
  execute(ctx: JobContext): void | Promise<void>;
}

/** Creates a job handler. */
export function newJob(options: JobOptions): JobHandler {
  return {
    id: options.id,
    name: options.name,
    parameters: options.parameters ?? [],
    execute: options.execute,
  };
}

/**
 * The structured meta every job event carries. Shared with the workflow
 * server: keep the keys byte-identical with sdk-go's jobs.JobEventMeta.
 */
export interface JobEventMeta {
  job_id: string;
  job_name: string;
  timestamp: string;
  task_name?: string;
  status?: string;
  log_level?: string;
  error?: string;
  progress_current?: number;
  progress_total?: number;
}

/** Job event meta with the current time, as sdk-go's NewJobEventMeta. */
export function newJobEventMeta(jobId: string, jobName: string): JobEventMeta {
  return { job_id: jobId, job_name: jobName, timestamp: new Date().toISOString() };
}

/** Reads job event meta leniently: wrong types read as absent. */
export function parseJobEventMeta(meta: Record<string, unknown> | null | undefined): JobEventMeta {
  const m = meta ?? {};
  const str = (k: string) => (typeof m[k] === 'string' ? (m[k] as string) : '');
  const num = (k: string) => (typeof m[k] === 'number' ? Math.trunc(m[k] as number) : 0);
  const out: JobEventMeta = { job_id: str('job_id'), job_name: str('job_name'), timestamp: str('timestamp') };
  if (str('task_name')) out.task_name = str('task_name');
  if (str('status')) out.status = str('status');
  if (str('log_level')) out.log_level = str('log_level');
  if (str('error')) out.error = str('error');
  if (num('progress_total') > 0) {
    out.progress_current = num('progress_current');
    out.progress_total = num('progress_total');
  }
  return out;
}

/**
 * A run id in sdk-go's format: run_{yyyyMMdd_HHmmss}_{4 hex}. Workflow-server
 * generates the ids of triggered runs; this is for runs started locally.
 */
export function generateRunId(): string {
  return `run_${stamp()}_${randomHex()}`;
}

/** Like generateRunId, prefixed with the job id: {jobId}_run_{...}. */
export function generateJobRunId(jobId: string): string {
  return `${jobId}_run_${stamp()}_${randomHex()}`;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function randomHex(): string {
  return Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0');
}
