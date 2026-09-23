import { JobLogger } from './logger';

/** Everything a job run gets: its ids, its arguments and its logger. */
export class JobContext {
  constructor(
    /** The run id workflow-server generated at trigger time. */
    readonly runId: string,
    readonly jobId: string,
    readonly jobName: string,
    /** The trigger's JSON arguments. */
    readonly args: Record<string, unknown>,
    readonly logger: JobLogger,
  ) {}

  getArg(name: string): unknown {
    return this.args[name];
  }

  getStringArg(name: string, defaultValue: string): string {
    const v = this.args[name];
    return typeof v === 'string' ? v : defaultValue;
  }

  /** A number argument truncated to an integer, as sdk-go's GetIntArg. */
  getIntArg(name: string, defaultValue: number): number {
    const v = this.args[name];
    return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : defaultValue;
  }

  getNumberArg(name: string, defaultValue: number): number {
    const v = this.args[name];
    return typeof v === 'number' ? v : defaultValue;
  }

  getBoolArg(name: string, defaultValue: boolean): boolean {
    const v = this.args[name];
    return typeof v === 'boolean' ? v : defaultValue;
  }
}
