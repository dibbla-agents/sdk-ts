import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
// protobufjs is CommonJS with dynamically assigned exports: the default
// import works from both the CJS and the ESM build, a namespace import
// does not under Node's ESM loader.
import protobuf from 'protobufjs';

/**
 * The wire contract, identical to sdk-go's internal/workflowsgrpc/events.proto
 * (and to src/proto/events.proto, kept as the readable reference; a test holds
 * the two together).
 *
 * It is embedded rather than read from disk at runtime: 0.0.1 looked for the
 * file next to its compiled output, where it was never shipped, so the
 * published package could not connect at all.
 */
export const EVENTS_PROTO = `syntax = "proto3";

package workflows;

import "google/protobuf/struct.proto";

message GrpcEventMessage {
  string function = 1;
  string node = 2;
  string workflow = 3;
  string version = 4;
  string server = 5;
  string event = 6;
  string text = 7;
  string run = 8;
  google.protobuf.Struct meta = 9;
  bytes payload = 10;
  string correlation_id = 11;
}

service EventService {
  rpc Events(stream GrpcEventMessage) returns (stream GrpcEventMessage);
}
`;

let eventServiceCtor: grpc.ServiceClientConstructor | undefined;

/** The generated EventService client constructor. */
export function eventService(): grpc.ServiceClientConstructor {
  if (!eventServiceCtor) {
    const { root } = protobuf.parse(EVENTS_PROTO, { keepCase: true });
    // google/protobuf/struct.proto from protobufjs's bundled well-known types.
    root.addJSON(protobuf.common.get('google/protobuf/struct.proto')!.nested!);
    const definition = protoLoader.fromJSON(root.toJSON(), {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: false,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(definition) as unknown as {
      workflows: { EventService: grpc.ServiceClientConstructor };
    };
    eventServiceCtor = proto.workflows.EventService;
  }
  return eventServiceCtor;
}
