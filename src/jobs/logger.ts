import { EventMessage, Events } from '../types/events';
import { JobStatus, newJobEventMeta } from './types';

/** What the logger needs to send job events. */
export interface JobEventSender {
  sendEvent(event: EventMessage): Promise<void>;
}

/** Where the logger mirrors its lines; process.stdout by default. */
export interface LineWriter {
  write(text: string): unknown;
  isTTY?: boolean;
}

/**
 * Reports a job run's logs, tasks and progress to the workflow server and
 * mirrors them on the console.
 *
 * Events are sent in call order and never throw: a job keeps running if the
 * connection drops, and the failure is printed instead.
 */
export class JobLogger {
  private progressTotal: number | null = null;

  constructor(
    private readonly sender: JobEventSender,
    private readonly serverName: string,
    readonly runId: string,
    readonly jobId: string,
    readonly jobName: string,
    private currentTask = '',
    private writer: LineWriter = process.stdout,
  ) {}

  /** The task the logger reports under; set by taskStarted. */
  get taskName(): string {
    return this.currentTask;
  }

  /** A logger for the same run that reports under the given task. */
  withTask(taskName: string): JobLogger {
    return new JobLogger(this.sender, this.serverName, this.runId, this.jobId, this.jobName, taskName, this.writer);
  }

  /** Mirrors console output to another writer. */
  withWriter(writer: LineWriter): this {
    this.writer = writer;
    return this;
  }

  info(message: string): void {
    this.print('INFO', message);
    this.send(Events.LogMessage, message, { log_level: 'info' });
  }

  warn(message: string): void {
    this.print('WARN', message);
    this.send(Events.LogMessage, message, { log_level: 'warn' });
  }

  /** Alias for warn. */
  warning(message: string): void {
    this.warn(message);
  }

  error(message: string): void {
    this.print('ERROR', message);
    this.send(Events.LogMessage, message, { log_level: 'error' });
  }

  /** Progress towards a known total. */
  progress(current: number, total: number, message: string): void {
    this.send(Events.ProgressUpdate, message, { progress_current: current, progress_total: total });
    this.progressTotal = total;
    if (this.writer.isTTY) {
      const width = 50;
      const fraction = total > 0 ? Math.min(1, current / total) : 0;
      const filled = Math.floor(fraction * width);
      const bar = '='.repeat(filled) + (filled < width ? '>' + ' '.repeat(width - filled - 1) : '');
      this.writer.write(`\r[${bar}] ${String(Math.floor(fraction * 100)).padStart(3)}% ${message}`);
    }
  }

  /** Progress without a known total. */
  progressIndeterminate(current: number, message: string): void {
    this.send(Events.ProgressUpdate, message, { progress_current: current, progress_total: 0 });
    if (this.writer.isTTY) this.writer.write(`\r⏳ ${message}: ${current} processed...`);
  }

  /** Ends the console progress line. */
  completeProgress(): void {
    if (this.writer.isTTY && this.progressTotal !== null) this.writer.write('\n');
    this.progressTotal = null;
  }

  taskStarted(taskName: string): void {
    this.currentTask = taskName;
    this.print('TASK', `Started: ${taskName}`);
    this.send(Events.TaskStarted, '', { status: JobStatus.InProgress, task_name: taskName });
  }

  taskCompleted(): void {
    this.print('TASK', `Completed: ${this.currentTask}`);
    this.send(Events.TaskCompleted, '', { status: JobStatus.Completed, task_name: this.currentTask });
  }

  taskFailed(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.print('TASK', `Failed: ${this.currentTask} - ${message}`);
    this.send(Events.TaskFailed, '', { status: JobStatus.Failed, task_name: this.currentTask, error: message });
  }

  taskSkipped(reason: string): void {
    this.print('TASK', `Skipped: ${this.currentTask} - ${reason}`);
    this.send(Events.TaskSkipped, reason, { status: JobStatus.Skipped, task_name: this.currentTask });
  }

  private send(event: string, text: string, extra: Record<string, unknown>): void {
    const meta: Record<string, unknown> = { ...newJobEventMeta(this.jobId, this.jobName) };
    if (this.currentTask) meta.task_name = this.currentTask;
    Object.assign(meta, extra);
    this.sender
      .sendEvent({
        function: '',
        node: '',
        workflow: '',
        version: '',
        server: this.serverName,
        event,
        text,
        run: this.runId,
        meta,
        payload: null,
        correlationId: this.runId,
      })
      .catch((err) => this.writer.write(`[ERROR] Failed to send ${event} event: ${(err as Error).message}\n`));
  }

  private print(level: string, message: string): void {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    const task = this.currentTask ? `[${this.currentTask}]` : '';
    this.writer.write(`${time} [${this.jobId}][${level}]${task} ${message}\n`);
  }
}
