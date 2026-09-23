import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fromGrpc, toGrpc, GrpcEventMessage } from '../src/internal/grpc/envelope';
import { EventMessage } from '../src/types/events';

// Round-trip through the real protobuf codec the communicator uses, so the
// test catches field-name mismatches that a pure object round-trip would not.
const definition = protoLoader.loadSync(path.join(__dirname, '../src/proto/events.proto'), {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: false,
  oneofs: true,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const method = (grpc.loadPackageDefinition(definition) as any).workflows.EventService.service.Events;
const overTheWire = (m: GrpcEventMessage): GrpcEventMessage => method.responseDeserialize(method.requestSerialize(m));

const base: EventMessage = {
  function: 'f',
  node: 'n',
  workflow: 'w',
  version: '1.0.0',
  server: 's',
  event: 'function_request',
  text: 't',
  run: 'r',
  meta: null,
  payload: null,
  correlationId: 'c',
};

describe('envelope', () => {
  it('round-trips every scalar field', () => {
    const back = fromGrpc(overTheWire(toGrpc({ ...base, payload: Buffer.from('{"a":1}') })));
    assert.deepEqual({ ...back, payload: back.payload?.toString() }, { ...base, payload: '{"a":1}' });
  });

  it('round-trips meta as a protobuf Struct', () => {
    const meta = {
      Key: '676529269163292368',
      TTL: 60,
      flag: true,
      none: null,
      nested: { deep: { list: [1, 'two', false, null, { three: 3 }] } },
      empty: {},
      emptyList: [],
    };
    const back = fromGrpc(overTheWire(toGrpc({ ...base, meta })));
    assert.deepEqual(back.meta, meta);
  });

  it('drops undefined properties like JSON does and sends dates as strings', () => {
    const back = fromGrpc(overTheWire(toGrpc({ ...base, meta: { a: undefined, b: 1, at: new Date('2026-01-01T00:00:00Z') } })));
    assert.deepEqual(back.meta, { b: 1, at: '2026-01-01T00:00:00.000Z' });
  });

  it('reads absent meta and payload as null, and empty payload as absent', () => {
    const back = fromGrpc(overTheWire(toGrpc({ ...base, payload: Buffer.alloc(0) })));
    assert.equal(back.meta, null);
    assert.equal(back.payload, null);
  });

  it('refuses meta values a Struct cannot carry', () => {
    assert.throws(() => toGrpc({ ...base, meta: { f: () => 1 } }), /cannot be sent in a protobuf Struct/);
  });
});

describe('embedded proto', () => {
  it('is the reference events.proto, which is sdk-go\'s', async () => {
    const { EVENTS_PROTO } = await import('../src/internal/grpc/proto');
    const reference = (await import('node:fs')).readFileSync(path.join(__dirname, '../src/proto/events.proto'), 'utf8');
    assert.equal(EVENTS_PROTO.trim(), reference.trim());
  });
});
