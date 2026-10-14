import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { createDefaultConfig, mergeConfig, resolveTLS } from '../src/config';

const KEYS = [
  'SERVER_NAME',
  'GRPC_SERVER_ADDRESS',
  'SERVER_API_TOKEN',
  'DIBBLA_IDENTITY_TOKEN_FILE',
  'SERVER_ORG_ID',
  'GRPC_USE_TLS',
  'GRPC_TLS_INSECURE_SKIP_VERIFY',
  'GRPC_KEEPALIVE_TIME_SEC',
  'GRPC_KEEPALIVE_TIMEOUT_SEC',
  'DIBBLA_GRPC_SERVER_ADDRESS',
  'DIBBLA_GRPC_USE_TLS',
];

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('config', () => {
  it('has production defaults', () => {
    const c = createDefaultConfig();
    assert.equal(c.serverName, 'codex-ts-worker');
    assert.equal(c.grpcServerAddress, 'grpc.dibbla.com:443');
    assert.equal(c.serverApiToken, '');
    assert.equal(c.identityTokenFile, '');
    assert.equal(c.orgId, '');
    assert.equal(c.useTLS, null);
    assert.equal(c.tlsInsecureSkipVerify, false);
    assert.equal(c.handlersConcurrency, 8);
    assert.equal(c.incomingEventsBuffer, 100);
    assert.equal(c.grpcReconnectIntervalSec, 5);
    assert.equal(c.pingIntervalSec, 30);
    assert.equal(c.grpcKeepaliveTimeSec, 0);
    assert.equal(c.grpcKeepaliveTimeoutSec, 0);
    assert.equal(resolveTLS(c), true);
  });

  it('reads the same environment variables as sdk-go', () => {
    Object.assign(process.env, {
      SERVER_NAME: 'w',
      GRPC_SERVER_ADDRESS: 'localhost:50051',
      SERVER_API_TOKEN: 'ak_1',
      DIBBLA_IDENTITY_TOKEN_FILE: '/tmp/token',
      SERVER_ORG_ID: 'org-1',
      GRPC_TLS_INSECURE_SKIP_VERIFY: '1',
      GRPC_KEEPALIVE_TIME_SEC: '30',
      GRPC_KEEPALIVE_TIMEOUT_SEC: '10',
    });
    const c = createDefaultConfig();
    assert.equal(c.serverName, 'w');
    assert.equal(c.serverApiToken, 'ak_1');
    assert.equal(c.identityTokenFile, '/tmp/token');
    assert.equal(c.orgId, 'org-1');
    assert.equal(c.tlsInsecureSkipVerify, true);
    assert.equal(c.grpcKeepaliveTimeSec, 30);
    assert.equal(c.grpcKeepaliveTimeoutSec, 10);
    assert.equal(resolveTLS(c), false, 'localhost is plaintext');
  });

  it('ignores malformed integers and treats empty variables as unset', () => {
    process.env.GRPC_KEEPALIVE_TIME_SEC = '30s';
    process.env.SERVER_NAME = '';
    const c = createDefaultConfig();
    assert.equal(c.grpcKeepaliveTimeSec, 0);
    assert.equal(c.serverName, 'codex-ts-worker');
  });

  it('lets options override the environment, and GRPC_USE_TLS override auto-detection', () => {
    process.env.SERVER_ORG_ID = 'org-env';
    process.env.GRPC_USE_TLS = 'false';
    const c = mergeConfig({ orgId: 'org-opt' });
    assert.equal(c.orgId, 'org-opt');
    assert.equal(resolveTLS(c), false);
    assert.equal(resolveTLS(mergeConfig({ useTLS: true, grpcServerAddress: 'localhost:1' })), true);
  });
});

// DIB-1430: the platform injects its own gRPC address so a worker deployed on
// a self-hosted install reaches that install, not grpc.dibbla.com.
describe('config: the platform gRPC address', () => {
  const PLATFORM = 'dibbla-grpc.internal:50051';

  it('uses DIBBLA_GRPC_SERVER_ADDRESS when GRPC_SERVER_ADDRESS is unset', () => {
    process.env.DIBBLA_GRPC_SERVER_ADDRESS = PLATFORM;
    assert.equal(createDefaultConfig().grpcServerAddress, PLATFORM);
    assert.equal(mergeConfig({}).grpcServerAddress, PLATFORM);
  });

  it('uses DIBBLA_GRPC_SERVER_ADDRESS when GRPC_SERVER_ADDRESS is blank', () => {
    process.env.GRPC_SERVER_ADDRESS = '  ';
    process.env.DIBBLA_GRPC_SERVER_ADDRESS = ` ${PLATFORM} `;
    assert.equal(mergeConfig({}).grpcServerAddress, PLATFORM);
    process.env.GRPC_SERVER_ADDRESS = '';
    assert.equal(mergeConfig({}).grpcServerAddress, PLATFORM);
  });

  it('lets GRPC_SERVER_ADDRESS win over the platform address', () => {
    process.env.GRPC_SERVER_ADDRESS = 'localhost:50051';
    process.env.DIBBLA_GRPC_SERVER_ADDRESS = PLATFORM;
    assert.equal(mergeConfig({}).grpcServerAddress, 'localhost:50051');
  });

  it('falls back to grpc.dibbla.com:443 when neither is set', () => {
    process.env.DIBBLA_GRPC_SERVER_ADDRESS = ' ';
    assert.equal(mergeConfig({}).grpcServerAddress, 'grpc.dibbla.com:443');
    assert.equal(resolveTLS(mergeConfig({})), true);
  });

  it('lets the grpcServerAddress option win over both', () => {
    process.env.GRPC_SERVER_ADDRESS = 'localhost:50051';
    process.env.DIBBLA_GRPC_SERVER_ADDRESS = PLATFORM;
    assert.equal(mergeConfig({ grpcServerAddress: 'grpc.other.example.com:443' }).grpcServerAddress, 'grpc.other.example.com:443');
  });

  it('applies DIBBLA_GRPC_USE_TLS to the platform address', () => {
    process.env.DIBBLA_GRPC_SERVER_ADDRESS = 'grpc.selfhosted.example.com:50051';
    process.env.DIBBLA_GRPC_USE_TLS = 'false';
    assert.equal(createDefaultConfig().useTLS, false);
    assert.equal(resolveTLS(mergeConfig({})), false, 'auto-detect alone would choose TLS');
    process.env.DIBBLA_GRPC_USE_TLS = '1';
    process.env.DIBBLA_GRPC_SERVER_ADDRESS = 'localhost:50051';
    assert.equal(resolveTLS(mergeConfig({})), true, 'auto-detect alone would choose plaintext');
  });

  it('never applies DIBBLA_GRPC_USE_TLS to an address the user chose', () => {
    process.env.DIBBLA_GRPC_SERVER_ADDRESS = PLATFORM;
    process.env.DIBBLA_GRPC_USE_TLS = 'false';

    // An address from GRPC_SERVER_ADDRESS: auto-detect.
    process.env.GRPC_SERVER_ADDRESS = 'grpc.other.example.com:443';
    assert.equal(createDefaultConfig().useTLS, null);
    assert.equal(resolveTLS(mergeConfig({})), true);
    delete process.env.GRPC_SERVER_ADDRESS;

    // An address from the option: auto-detect, even when it names the platform's own address.
    assert.equal(mergeConfig({ grpcServerAddress: 'grpc.other.example.com:443' }).useTLS, null);
    assert.equal(mergeConfig({ grpcServerAddress: PLATFORM }).useTLS, null);

    // No platform address: the hint alone does nothing.
    delete process.env.DIBBLA_GRPC_SERVER_ADDRESS;
    assert.equal(mergeConfig({}).useTLS, null);
  });

  it('lets GRPC_USE_TLS and the useTLS option win over DIBBLA_GRPC_USE_TLS', () => {
    process.env.DIBBLA_GRPC_SERVER_ADDRESS = PLATFORM;
    process.env.DIBBLA_GRPC_USE_TLS = 'false';
    process.env.GRPC_USE_TLS = 'true';
    assert.equal(mergeConfig({}).useTLS, true);
    assert.equal(createDefaultConfig().useTLS, true);
    process.env.GRPC_USE_TLS = 'false';
    assert.equal(mergeConfig({ useTLS: true }).useTLS, true);
  });

  it('reads true/1 and false/0 from DIBBLA_GRPC_USE_TLS and ignores anything else', () => {
    process.env.DIBBLA_GRPC_SERVER_ADDRESS = PLATFORM;
    const cases: Array<[string, boolean | null]> = [
      ['true', true],
      ['1', true],
      [' true ', true],
      ['false', false],
      ['0', false],
      ['', null],
      ['yes', null],
      ['TRUE', null],
    ];
    for (const [value, want] of cases) {
      process.env.DIBBLA_GRPC_USE_TLS = value;
      assert.equal(mergeConfig({}).useTLS, want, `DIBBLA_GRPC_USE_TLS=${JSON.stringify(value)}`);
    }
  });
});
