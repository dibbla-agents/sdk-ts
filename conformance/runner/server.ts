/**
 * A fake workflow server: the EventService side of the wire, driven by a
 * scenario instead of a workflow engine.
 */
import * as path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

/** One envelope as it crosses the wire, normalized for matching. */
export interface WireMessage {
  function: string;
  node: string;
  workflow: string;
  version: string;
  server: string;
  event: string;
  text: string;
  run: string;
  /** Absent and empty Struct are indistinguishable to a receiver, so both become {}. */
  meta: Record<string, unknown>;
  payload: Buffer;
  correlation_id: string;
}

const PROTO_PATH = path.resolve(__dirname, '../../src/proto/events.proto');

type ProtoValue = {
  nullValue?: unknown;
  numberValue?: number;
  stringValue?: string;
  boolValue?: boolean;
  structValue?: { fields?: Record<string, ProtoValue> };
  listValue?: { values?: ProtoValue[] };
  kind?: string;
};

function fromValue(v: ProtoValue): unknown {
  switch (v.kind) {
    case 'nullValue':
      return null;
    case 'numberValue':
      return v.numberValue;
    case 'stringValue':
      return v.stringValue;
    case 'boolValue':
      return v.boolValue;
    case 'structValue':
      return fromStruct(v.structValue?.fields ?? {});
    case 'listValue':
      return (v.listValue?.values ?? []).map(fromValue);
    default:
      // A Value with no kind set. Go's structpb.AsMap reads it as nil.
      return null;
  }
}

function fromStruct(fields: Record<string, ProtoValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = fromValue(v);
  return out;
}

function toValue(v: unknown): ProtoValue {
  if (v === null || v === undefined) return { nullValue: 'NULL_VALUE' };
  if (typeof v === 'number') return { numberValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (Array.isArray(v)) return { listValue: { values: v.map(toValue) } };
  if (typeof v === 'object') return { structValue: { fields: toStruct(v as Record<string, unknown>) } };
  throw new Error(`cannot encode ${typeof v} in a protobuf Struct`);
}

function toStruct(obj: Record<string, unknown>): Record<string, ProtoValue> {
  const out: Record<string, ProtoValue> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = toValue(v);
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromGrpc(m: any): WireMessage {
  return {
    function: m.function ?? '',
    node: m.node ?? '',
    workflow: m.workflow ?? '',
    version: m.version ?? '',
    server: m.server ?? '',
    event: m.event ?? '',
    text: m.text ?? '',
    run: m.run ?? '',
    meta: m.meta ? fromStruct(m.meta.fields ?? {}) : {},
    payload: m.payload ? Buffer.from(m.payload) : Buffer.alloc(0),
    correlation_id: m.correlation_id ?? '',
  };
}

function toGrpc(m: WireMessage) {
  return {
    ...m,
    meta: Object.keys(m.meta).length > 0 ? { fields: toStruct(m.meta) } : null,
    payload: m.payload.length > 0 ? m.payload : null,
  };
}

/** An unbounded FIFO with a timed async shift. */
class Queue<T> {
  private items: T[] = [];
  private waiters: ((v: T) => void)[] = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  /** Resolves with the next item, or undefined if none arrives in time. */
  shift(timeoutMs: number): Promise<T | undefined> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => {
      const waiter = (v: T) => {
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(undefined);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

export class AcceptedStream {
  readonly metadata: Record<string, string>;
  readonly messages = new Queue<WireMessage>();
  private closed = false;

  constructor(private readonly call: grpc.ServerDuplexStream<unknown, unknown>) {
    this.metadata = {};
    for (const [k, v] of Object.entries(call.metadata.getMap())) {
      this.metadata[k] = Buffer.isBuffer(v) ? v.toString('base64') : String(v);
    }
    call.on('data', (m) => this.messages.push(fromGrpc(m)));
    call.on('error', () => undefined); // the client going away is not a runner failure
    call.on('end', () => {
      this.closed = true;
    });
  }

  send(message: WireMessage): void {
    this.call.write(toGrpc(message));
  }

  /** Finishes the stream, with an error status unless code is OK. */
  end(code: grpc.status, details: string): void {
    if (this.closed) return;
    this.closed = true;
    if (code === grpc.status.OK) {
      this.call.end();
    } else {
      this.call.emit('error', { code, details });
    }
  }
}

export class FakeWorkflowServer {
  readonly streams = new Queue<AcceptedStream>();
  private server = new grpc.Server();
  private live: AcceptedStream[] = [];
  port = 0;

  async start(): Promise<void> {
    const def = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: false,
      oneofs: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = grpc.loadPackageDefinition(def) as any;
    this.server.addService(proto.workflows.EventService.service, {
      Events: (call: grpc.ServerDuplexStream<unknown, unknown>) => {
        const stream = new AcceptedStream(call);
        this.live.push(stream);
        this.streams.push(stream);
      },
    });
    this.port = await new Promise<number>((resolve, reject) => {
      this.server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, port) =>
        err ? reject(err) : resolve(port),
      );
    });
  }

  async stop(): Promise<void> {
    for (const s of this.live) s.end(grpc.status.UNAVAILABLE, 'runner shutting down');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.server.forceShutdown();
        resolve();
      }, 1000);
      this.server.tryShutdown(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
