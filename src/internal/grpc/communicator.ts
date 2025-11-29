import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'path';
import { EventEmitter } from 'events';
import { EventMessage, Events } from '../../types/events';

// Type definitions for the gRPC service
interface GrpcEventMessage {
  function: string;
  node: string;
  workflow: string;
  version: string;
  server: string;
  event: string;
  text: string;
  run: string;
  meta: { fields: Record<string, unknown> } | null;
  payload: Buffer | null;
  correlation_id: string;
}

interface EventServiceClient {
  Events(metadata?: grpc.Metadata): grpc.ClientDuplexStream<GrpcEventMessage, GrpcEventMessage>;
}

export interface GrpcCommunicatorOptions {
  serverAddress: string;
  serverName: string;
  apiToken: string;
  useTLS?: boolean;
  incomingBuffer?: number;
  reconnectIntervalSec?: number;
  healthcheckIntervalSec?: number;
  pingIntervalSec?: number;
}

/**
 * Determine if TLS should be used based on the server address.
 * localhost/127.0.0.1/[::1] = no TLS (development)
 * Everything else = TLS (production)
 */
export function shouldUseTLS(address: string): boolean {
  if (
    address.startsWith('localhost:') ||
    address.startsWith('127.0.0.1:') ||
    address.startsWith('[::1]:')
  ) {
    return false;
  }
  return true;
}

/**
 * GrpcCommunicator implements the bidirectional streaming gRPC connection
 * to the workflow server.
 */
export class GrpcCommunicator extends EventEmitter {
  private serverAddress: string;
  private serverName: string;
  private apiToken: string;
  private useTLS: boolean;

  private client: EventServiceClient | null = null;
  private stream: grpc.ClientDuplexStream<GrpcEventMessage, GrpcEventMessage> | null = null;
  private grpcClient: grpc.Client | null = null;

  private connected = false;
  private connecting = false;
  private closed = false;

  private reconnectIntervalSec: number;
  private healthcheckIntervalSec: number;
  private pingIntervalSec: number;

  private reconnectTimer: NodeJS.Timeout | null = null;
  private healthcheckTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(options: GrpcCommunicatorOptions) {
    super();
    this.serverAddress = options.serverAddress;
    this.serverName = options.serverName;
    this.apiToken = options.apiToken;
    this.useTLS = options.useTLS ?? shouldUseTLS(options.serverAddress);
    this.reconnectIntervalSec = options.reconnectIntervalSec ?? 5;
    this.healthcheckIntervalSec = options.healthcheckIntervalSec ?? 30;
    this.pingIntervalSec = options.pingIntervalSec ?? 30;
  }

  /**
   * Start the connection process.
   * Returns immediately; connection happens in background with retries.
   */
  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('Communicator has been closed');
    }

    this.connectionLoop();
    console.log(
      `Started gRPC connection attempts to ${this.serverAddress} (will retry every ${this.reconnectIntervalSec} seconds until successful)`
    );
  }

  /**
   * Send an event message to the workflow server.
   */
  async sendEvent(event: EventMessage): Promise<void> {
    if (!this.connected || !this.stream) {
      throw new Error('Not connected to workflow server');
    }

    const grpcMsg = this.convertToGrpc(event);
    
    return new Promise((resolve, reject) => {
      if (!this.stream) {
        reject(new Error('Stream not available'));
        return;
      }

      const success = this.stream.write(grpcMsg);
      if (success) {
        console.log(`Sent event via gRPC: ${event.event}`);
        resolve();
      } else {
        // Handle backpressure - wait for drain
        this.stream.once('drain', () => {
          console.log(`Sent event via gRPC (after drain): ${event.event}`);
          resolve();
        });
      }
    });
  }

  /**
   * Check if currently connected to the server.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Close the communicator and clean up resources.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.stopTimers();
    this.disconnect();
    console.log('gRPC client closed');
  }

  // Private methods

  private async connectionLoop(): Promise<void> {
    while (!this.closed) {
      if (await this.attemptConnection()) {
        // Successfully connected, start monitoring
        this.startHealthcheck();
        this.startPingLoop();
        return;
      }

      // Wait before next attempt
      await this.sleep(this.reconnectIntervalSec * 1000);
    }
  }

  private async attemptConnection(): Promise<boolean> {
    if (this.connecting || this.connected) {
      return this.connected;
    }

    this.connecting = true;
    console.log(`Attempting to connect to gRPC server at ${this.serverAddress}...`);

    if (!this.apiToken) {
      console.warn(
        '⚠️  Warning: No API token provided. Set SERVER_API_TOKEN environment variable for authentication.'
      );
    }

    try {
      // Load proto definition
      const protoPath = path.join(__dirname, '../../proto/events.proto');
      const packageDefinition = await protoLoader.load(protoPath, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
        includeDirs: [path.join(__dirname, '../../proto')],
      });

      const proto = grpc.loadPackageDefinition(packageDefinition);
      const EventService = (proto.workflows as { EventService: grpc.ServiceClientConstructor }).EventService;

      // Create credentials
      let credentials: grpc.ChannelCredentials;
      if (this.useTLS) {
        credentials = grpc.credentials.createSsl();
        console.log(`Connecting with TLS to ${this.serverAddress}`);
      } else {
        credentials = grpc.credentials.createInsecure();
        console.log(`Connecting without TLS to ${this.serverAddress}`);
      }

      // Create client
      this.grpcClient = new EventService(this.serverAddress, credentials);
      this.client = this.grpcClient as unknown as EventServiceClient;

      // Wait for connection to be ready
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 5000;
        this.grpcClient!.waitForReady(deadline, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      // Create metadata with auth token
      const metadata = new grpc.Metadata();
      if (this.apiToken) {
        metadata.set('authorization', `Bearer ${this.apiToken}`);
      }

      // Create bidirectional stream with metadata
      this.stream = this.client.Events(metadata);
      
      // Set up stream event handlers
      this.setupStreamHandlers();

      // Send registration message
      const registrationMsg: GrpcEventMessage = {
        function: '',
        node: '',
        workflow: '',
        version: '',
        server: this.serverName,
        event: Events.ClientRegistration,
        text: 'Client registration',
        run: '',
        meta: null,
        payload: null,
        correlation_id: '',
      };

      this.stream.write(registrationMsg);

      this.connected = true;
      this.connecting = false;
      console.log(`✅ gRPC client successfully connected to workflow server at ${this.serverAddress}`);
      
      this.emit('connected');
      return true;
    } catch (err) {
      this.connecting = false;
      const error = err as Error;
      
      if (error.message?.includes('UNAUTHENTICATED')) {
        if (!this.apiToken) {
          console.error(
            '❌ Authentication failed: No API token provided. Set SERVER_API_TOKEN environment variable.'
          );
        } else {
          console.error(`❌ Authentication failed: Invalid or expired API token. Error: ${error.message}`);
        }
      } else {
        console.error(`Failed to connect to gRPC server: ${error.message}`);
      }
      
      return false;
    }
  }

  private setupStreamHandlers(): void {
    if (!this.stream) return;

    this.stream.on('data', (msg: GrpcEventMessage) => {
      try {
        console.log(`[DEBUG GRPC] Raw incoming message:`, JSON.stringify({
          event: msg.event,
          function: msg.function,
          version: msg.version,
          node: msg.node,
          workflow: msg.workflow,
          run: msg.run,
          server: msg.server,
          correlation_id: msg.correlation_id,
          text: msg.text,
          hasPayload: !!msg.payload,
          payloadLength: msg.payload?.length ?? 0,
        }, null, 2));
        
        const eventMsg = this.convertFromGrpc(msg);
        console.log(`[DEBUG GRPC] Converted event: ${eventMsg.event}`);
        this.emit('message', eventMsg);
      } catch (err) {
        console.error('[DEBUG GRPC] Failed to convert gRPC message:', err);
      }
    });

    this.stream.on('error', (err: Error) => {
      console.error(`gRPC stream error: ${err.message}`);
      this.handleDisconnect();
    });

    this.stream.on('end', () => {
      console.log('gRPC stream closed by server');
      this.handleDisconnect();
    });
  }

  private handleDisconnect(): void {
    if (this.closed) return;

    this.connected = false;
    this.stopTimers();
    this.emit('disconnected');

    console.log('Connection lost, attempting to reconnect...');
    this.disconnect();
    
    // Schedule reconnection
    this.reconnectTimer = setTimeout(() => {
      this.connectionLoop();
    }, this.reconnectIntervalSec * 1000);
  }

  private disconnect(): void {
    this.connected = false;

    if (this.stream) {
      try {
        this.stream.end();
      } catch {
        // Ignore errors during cleanup
      }
      this.stream = null;
    }

    if (this.grpcClient) {
      try {
        this.grpcClient.close();
      } catch {
        // Ignore errors during cleanup
      }
      this.grpcClient = null;
      this.client = null;
    }
  }

  private startHealthcheck(): void {
    if (this.healthcheckIntervalSec <= 0) return;

    this.healthcheckTimer = setInterval(() => {
      if (!this.connected) return;

      // Check gRPC channel state
      if (this.grpcClient) {
        const state = this.grpcClient.getChannel().getConnectivityState(false);
        if (
          state === grpc.connectivityState.TRANSIENT_FAILURE ||
          state === grpc.connectivityState.SHUTDOWN
        ) {
          console.log(`Connection unhealthy (state: ${state}), triggering reconnection`);
          this.handleDisconnect();
        }
      }
    }, this.healthcheckIntervalSec * 1000);
  }

  private startPingLoop(): void {
    if (this.pingIntervalSec <= 0) return;

    this.pingTimer = setInterval(() => {
      this.sendPing();
    }, this.pingIntervalSec * 1000);
  }

  private async sendPing(): Promise<void> {
    if (!this.connected) return;

    try {
      const pingEvent: EventMessage = {
        function: '',
        node: '',
        workflow: '',
        version: '',
        server: this.serverName,
        event: Events.Ping,
        text: 'ping',
        run: '',
        meta: null,
        payload: null,
        correlationId: '',
      };

      await this.sendEvent(pingEvent);
      console.log('Sent ping to workflow server');
    } catch (err) {
      console.error(`Failed to send ping: ${(err as Error).message}`);
    }
  }

  private stopTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.healthcheckTimer) {
      clearInterval(this.healthcheckTimer);
      this.healthcheckTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private convertToGrpc(event: EventMessage): GrpcEventMessage {
    let meta: { fields: Record<string, unknown> } | null = null;
    if (event.meta) {
      meta = { fields: this.convertMetaToStruct(event.meta) };
    }

    return {
      function: event.function,
      node: event.node,
      workflow: event.workflow,
      version: event.version,
      server: event.server,
      event: event.event,
      text: event.text,
      run: event.run,
      meta,
      payload: event.payload,
      correlation_id: event.correlationId,
    };
  }

  private convertFromGrpc(grpcMsg: GrpcEventMessage): EventMessage {
    let meta: Record<string, unknown> | null = null;
    if (grpcMsg.meta?.fields) {
      meta = this.convertStructToMeta(grpcMsg.meta.fields);
    }

    return {
      function: grpcMsg.function,
      node: grpcMsg.node,
      workflow: grpcMsg.workflow,
      version: grpcMsg.version,
      server: grpcMsg.server,
      event: grpcMsg.event,
      text: grpcMsg.text,
      run: grpcMsg.run,
      meta,
      payload: grpcMsg.payload && grpcMsg.payload.length > 0 ? Buffer.from(grpcMsg.payload) : null,
      correlationId: grpcMsg.correlation_id,
    };
  }

  private convertMetaToStruct(meta: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(meta)) {
      result[key] = this.wrapValue(value);
    }
    return result;
  }

  private wrapValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return { nullValue: 0 };
    }
    if (typeof value === 'boolean') {
      return { boolValue: value };
    }
    if (typeof value === 'number') {
      return { numberValue: value };
    }
    if (typeof value === 'string') {
      return { stringValue: value };
    }
    if (Array.isArray(value)) {
      return { listValue: { values: value.map(v => this.wrapValue(v)) } };
    }
    if (typeof value === 'object') {
      return { structValue: { fields: this.convertMetaToStruct(value as Record<string, unknown>) } };
    }
    return { stringValue: String(value) };
  }

  private convertStructToMeta(fields: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      result[key] = this.unwrapValue(value);
    }
    return result;
  }

  private unwrapValue(value: unknown): unknown {
    if (!value || typeof value !== 'object') {
      return value;
    }
    
    const v = value as Record<string, unknown>;
    
    if ('nullValue' in v) return null;
    if ('boolValue' in v) return v.boolValue;
    if ('numberValue' in v) return v.numberValue;
    if ('stringValue' in v) return v.stringValue;
    if ('listValue' in v) {
      const list = v.listValue as { values?: unknown[] };
      return list.values?.map(item => this.unwrapValue(item)) ?? [];
    }
    if ('structValue' in v) {
      const struct = v.structValue as { fields?: Record<string, unknown> };
      return struct.fields ? this.convertStructToMeta(struct.fields) : {};
    }
    
    return value;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

