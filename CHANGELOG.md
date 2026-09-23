# Changelog

## 0.1.0

The TypeScript SDK brought to parity with sdk-go v0.0.24 (DIB-1018). A
cross-SDK conformance suite (`conformance/`) now pins the wire behaviour, and
this release passes all of it.

**0.0.1 could not connect.** It loaded its protocol definition from a path
that was not in the published package, so every connection attempt failed and
the worker retried forever. The definition is now built in.

### Added

- **Workload identity.** On the Dibbla platform a worker authenticates with
  the projected identity token (`DIBBLA_IDENTITY_TOKEN_FILE`) with no
  configuration, re-reading it on every connect. `SERVER_ORG_ID` pins the
  organization (`x-org-id`).
- **Jobs.** `newJob`, `server.registerJob`, `JobContext` and `JobLogger`
  (logs, tasks, progress), plus `originHeaders` for run-origin stamping.
- **Capability providers.** `toolSearchProvider` and `memoryProvider`, with
  extra ports and cancellation, registered with
  `server.registerCapabilityProvider`.
- **Verified caller.** Simple handlers receive `{ caller, signal, event }`;
  `callerFromEvent(event)` for advanced handlers.
- `server.stop()`, `setLogLevel` / `SDK_LOG_LEVEL`, HTTP/2 keepalive
  settings (`GRPC_KEEPALIVE_TIME_SEC`, `GRPC_KEEPALIVE_TIMEOUT_SEC`),
  `GRPC_TLS_INSECURE_SKIP_VERIFY`.
- `{ timeoutMs, signal }` on store, cache, OAuth and RPC requests;
  `TimeoutError` and `OAuthError` are exported.
- ES module build alongside CommonJS, with an `exports` map.

### Changed

- **Reconnects** use jittered exponential backoff (5s doubling to 5 minutes,
  reset after a healthy minute). A rejected credential waits 5 minutes
  instead of retrying every 5 seconds. The worker registers everything again
  after each reconnect, which it previously did not do at all.
- **Published schemas** follow sdk-go #14: an array is declared under the key
  callers send (`"tags": "[]string"`) instead of `"tags[]"`, and type names
  use Go's spelling (`interface {}`).
- **Responses** match sdk-go: function responses and errors no longer carry
  `server`, errors read `Function execution failed: handler error: <message>`,
  and output keys outside the output schema are dropped.
- **Cache keys** hash payload bytes, matching sdk-go for non-ASCII payloads.
  The TTL is sent in whole seconds, truncated. A failing cache is a miss.
- **Responses no longer queue behind busy handlers.** Store, cache, OAuth and
  RPC responses reach waiting handlers even when every handler slot is taken.
  A full queue fails new requests at once ("Worker overloaded").
- `store.get` throws `TimeoutError` when no answer arrives, instead of
  returning `null` as if the key were empty. `isProviderConnected` reports
  errors instead of `false`.
- `start()` rejects if no connection is made within 30 seconds (it used to
  continue unconnected), and resolves when `stop()` is called.
- A worker only counts as connected once the transport is up, so `start()`
  fails against an unreachable server instead of reporting success. Sends
  pending when a connection dies now fail instead of hanging.
- Schemas of intersections and object unions publish their fields.
  `bigint`, `date`, `set` and `map` fields decode from and encode to JSON.
  A cached value must match the output schema. A blank string is no longer
  read as 0. A timeout of 0 expires at once.
- Payloads are no longer written to the log.
- Requires Node.js 20 or later.
- Deep imports into `dist/` are no longer possible; import from the package root.
