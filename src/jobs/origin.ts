import type { JobContext } from './context';

/*
 * Run-origin stamping (DIB-256).
 *
 * A job that calls a workflow mid-execution produces a run on the server that
 * is indistinguishable from any other API call: nothing says which pipeline
 * task made it, so a task can make hundreds of rejected calls and still show
 * green. These headers on the job's workflow requests tie each run to its
 * task. The contract mirrors workflow-server endpoints/run_origin.go:
 *
 * - The stamp is validated all-or-nothing, so no value is ever emitted that
 *   would fail. An over-long label degrades to no label, not no stamp.
 * - An invalid or absent stamp is never an error; the run just goes
 *   unattributed.
 */

export const ORIGIN_KIND_HEADER = 'X-Dibbla-Origin-Kind';
export const ORIGIN_ID_HEADER = 'X-Dibbla-Origin-Id';
export const ORIGIN_LABEL_HEADER = 'X-Dibbla-Origin-Label';

/** The only kind the server accepts today. */
export const ORIGIN_KIND_PIPELINE_TASK = 'pipeline_task';

/** workflow-server's MaxOriginValueLength. */
const MAX_ORIGIN_VALUE_LENGTH = 256;

/**
 * The origin stamp for the workflow calls a job makes, or an empty object
 * when there is nothing valid to stamp. Always safe to spread into headers:
 *
 *   ctx.logger.taskStarted('GenerateSentiment');
 *   const origin = originHeaders(ctx);
 *   await fetch(url, { method: 'POST', headers: { ...origin, 'Content-Type': 'application/json' }, body });
 *
 * The id is ctx.runId: the run id workflow-server generated at trigger time,
 * which it stores as the pipeline run id, so it always joins. The label is
 * the current task name, read from the logger so it equals what task_started
 * carried. Call it once per task, after taskStarted and before any fan-out.
 */
export function originHeaders(ctx: JobContext | null | undefined): Record<string, string> {
  if (!ctx || !ctx.runId || ctx.runId.length > MAX_ORIGIN_VALUE_LENGTH) return {};

  const headers: Record<string, string> = {
    [ORIGIN_KIND_HEADER]: ORIGIN_KIND_PIPELINE_TASK,
    [ORIGIN_ID_HEADER]: ctx.runId,
  };
  const label = ctx.logger?.taskName;
  if (label && label.length <= MAX_ORIGIN_VALUE_LENGTH) {
    headers[ORIGIN_LABEL_HEADER] = label;
  }
  return headers;
}
