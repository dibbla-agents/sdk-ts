# Dev-cluster test worker

Runs the conformance profile worker ([../conformance/PROFILE.md](../conformance/PROFILE.md))
on the Dibbla dev cluster, against the SDK **as it would be published**: the packed
tarball, installed like any user's dependency. Use it before a release to check
the SDK against the real workflow engine.

```sh
devtest/bundle.sh /tmp/sdk-ts-devtest   # builds, packs, assembles the deploy dir
dibbla deploy /tmp/sdk-ts-devtest --alias sdk-ts-devtest --no-public --port 80 \
  --memory 256Mi --cpu 200m \
  -e SERVER_NAME=sdk-ts-devtest -e GRPC_SERVER_ADDRESS=grpc.dibbla.net:443 \
  -e CONFORMANCE_PING_INTERVAL_SEC=30 -e SDK_LOG_LEVEL=debug
```

Things learned the hard way:

- **Set `GRPC_SERVER_ADDRESS=grpc.dibbla.net:443`.** The SDK defaults to prod
  (`grpc.dibbla.com`), which rejects the dev cluster's identity token.
- **Set no `SERVER_API_TOKEN`.** The worker must authenticate with the platform's
  workload identity token; that is part of what is tested.
- **Give it 256Mi.** At the platform default of 64Mi, Node and tsx get killed.
- **Run only one worker with these function names in the org.** The engine keys
  its registry by organization and function name, not server. A second worker
  exposing `echo` (a local run, say) takes the names over, and when either one
  disconnects it deletes them for both.
- **Use `--force`, not `--update`, to change environment variables.** An
  `--update` deploy did not apply them.
- **Don't wire boolean or array outputs into string inputs.** The engine refuses
  to cast a boolean ("cannot cast value to string") and picks an arbitrary
  element of an array. Route results through string outputs.

Checks that passed on 2026-09-23 (0.1.0 plus the fixes on this branch):

| Check | How |
| --- | --- |
| Zero-config auth via workload identity | Deployed with no token; the worker connected and registered |
| Functions, cache, store, status | A workflow calling `cached_upper`, `store_append`, `status_ping` and `whoami` |
| Capability providers registered, extra ports parsed | `dibbla functions providers` |
| Memory provider invoked by an agent | Agent with `capability_providers: { memory: marker }`; the worker logged the call |
| Cancellation within the engine's budget | `memory: blocking`; the engine cancelled at 15.0 s and the handler aborted within 1 ms |
| Jobs | A pipeline for `count_job`, triggered over `POST /api/wf/pipelines/:id/trigger`; the engine recorded `completed` |
