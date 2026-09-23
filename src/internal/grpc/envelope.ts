import { EventMessage } from '../../types/events';

/**
 * The GrpcEventMessage shape @grpc/proto-loader produces and accepts with
 * keepCase. google.protobuf.Struct comes from protobufjs's bundled
 * definitions, whose field names are camelCase regardless of keepCase.
 */
export interface GrpcEventMessage {
  function?: string;
  node?: string;
  workflow?: string;
  version?: string;
  server?: string;
  event?: string;
  text?: string;
  run?: string;
  meta?: GrpcStruct | null;
  payload?: Buffer | Uint8Array | null;
  correlation_id?: string;
}

export interface GrpcStruct {
  fields?: Record<string, GrpcValue>;
}

export interface GrpcValue {
  nullValue?: number | string;
  numberValue?: number;
  stringValue?: string;
  boolValue?: boolean;
  structValue?: GrpcStruct;
  listValue?: { values?: GrpcValue[] };
  kind?: string;
}

function toValue(value: unknown): GrpcValue {
  switch (typeof value) {
    case 'string':
      return { stringValue: value };
    case 'number':
      return { numberValue: value };
    case 'bigint':
      return { numberValue: Number(value) };
    case 'boolean':
      return { boolValue: value };
    case 'undefined':
      return { nullValue: 0 };
    case 'object':
      if (value === null) return { nullValue: 0 };
      if (Array.isArray(value)) return { listValue: { values: value.map(toValue) } };
      if (value instanceof Date) return { stringValue: value.toISOString() };
      return { structValue: toStruct(value as Record<string, unknown>) };
    default:
      throw new Error(`meta value of type ${typeof value} cannot be sent in a protobuf Struct`);
  }
}

function toStruct(obj: Record<string, unknown>): GrpcStruct {
  const fields: Record<string, GrpcValue> = {};
  for (const [key, value] of Object.entries(obj)) {
    // Like JSON, an undefined property is no property.
    if (value !== undefined) fields[key] = toValue(value);
  }
  return { fields };
}

function fromValue(value: GrpcValue): unknown {
  switch (value.kind) {
    case 'stringValue':
      return value.stringValue;
    case 'numberValue':
      return value.numberValue;
    case 'boolValue':
      return value.boolValue;
    case 'structValue':
      return fromStruct(value.structValue);
    case 'listValue':
      return (value.listValue?.values ?? []).map(fromValue);
    default:
      // nullValue, or a Value with no kind set, which Go also reads as nil.
      return null;
  }
}

function fromStruct(struct: GrpcStruct | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(struct?.fields ?? {})) {
    out[key] = fromValue(value);
  }
  return out;
}

export function toGrpc(event: EventMessage): GrpcEventMessage {
  return {
    function: event.function,
    node: event.node,
    workflow: event.workflow,
    version: event.version,
    server: event.server,
    event: event.event,
    text: event.text,
    run: event.run,
    meta: event.meta ? toStruct(event.meta) : null,
    payload: event.payload && event.payload.length > 0 ? event.payload : null,
    correlation_id: event.correlationId,
  };
}

export function fromGrpc(message: GrpcEventMessage): EventMessage {
  return {
    function: message.function ?? '',
    node: message.node ?? '',
    workflow: message.workflow ?? '',
    version: message.version ?? '',
    server: message.server ?? '',
    event: message.event ?? '',
    text: message.text ?? '',
    run: message.run ?? '',
    meta: message.meta ? fromStruct(message.meta) : null,
    payload: message.payload && message.payload.length > 0 ? Buffer.from(message.payload) : null,
    correlationId: message.correlation_id ?? '',
  };
}
