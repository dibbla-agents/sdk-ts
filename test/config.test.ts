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
