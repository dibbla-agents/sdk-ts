# AGENTS.md

Guidance for anyone, human or coding agent, changing this repository:
`@dibbla/sdk-ts`, the TypeScript worker SDK for the Dibbla workflow engine.

## Branches and pull requests

- **`main` is protected.** Every change goes through a pull request that
  needs one approving review and all six CI checks:
  - `Test (Node 22)`, `Test (Node 24)`
  - `Packaged SDK (Node 20)`, `Packaged SDK (Node 22)`, `Packaged SDK (Node 24)`
  - `Conformance (Go worker, reference)`

  Never push to `main` directly and never force-push it. Admin bypass is for
  emergencies only.
- **Branch names:** `<user>/dib-<n>-<slug>`, for example
  `joakim/dib-1018-agents-md`. Work without a ticket is the exception; create
  the Plane item first.
- **PR titles:** `[DIB-123] short description`. The square brackets link the
  PR to the Plane item; `DIB-123` without them only makes a link, and
  `Fixes DIB-123` does nothing. Move the Plane item yourself
  (In Progress → In Review → Done), because merging doesn't.
- **Merge with a merge commit** (not squash) when the branch's commits are
  meaningful units, as the parity slices were. Squash is fine for a single
  logical change.
- **Merging to `main` can publish to npm** (see Releasing). Treat a version
  bump in `package.json` as a release decision, not a drive-by change.

## Releasing

Releases are automatic. Bump `version` in `package.json`, add a
`## <version>` section to `CHANGELOG.md`, and merge to `main`.
`.github/workflows/release.yml` then:

1. runs the full checks
2. publishes with provenance over npm trusted publishing (OIDC, no token)
3. tags `v<version>` and creates the GitHub release from the changelog section
4. installs the published version from npm and runs the conformance suite
   against it

A push that doesn't change the version publishes nothing. Never publish from
a laptop. The trust relationship is tied to the file name `release.yml`, so
renaming the workflow breaks publishing. Details in [RELEASING.md](RELEASING.md).

## Parity with sdk-go

sdk-go (`github.com/dibbla-agents/sdk-go`) is the reference implementation.
The wire protocol is one bidi gRPC stream with an untyped envelope, so nothing
fails at compile time when the SDKs drift apart. The conformance suite is what
catches it.

- `conformance/` holds language-neutral scenarios. **The Go worker must pass
  every scenario**; a scenario Go fails is a wrong scenario. See
  [conformance/README.md](conformance/README.md) and
  [conformance/PROFILE.md](conformance/PROFILE.md).
- A change to wire behaviour updates the scenarios in the same PR, verified
  with `npm run conformance:go` first, then `npm run conformance`.
- `conformance/known-gaps.json` lists TS scenarios expected to fail, and must
  shrink, never grow silently. The `go` list stays empty.

## Before you push

```sh
source ~/.nvm/nvm.sh && nvm use 22   # Node 22+ for development (the package supports >= 20)
npm ci
npm run typecheck
npm test                             # unit tests, including the README Quick Start
npm run conformance                  # 34 wire scenarios against this SDK
npm run build && npm run conformance:packed   # the package as published, require + import
npm run conformance:go               # the sdk-go reference (needs Go)
```

## Conventions worth knowing

- **Logging:** `SDK_LOG_LEVEL` sets the level, never a `DIBBLA_*` variable. The
  platform reserves the `DIBBLA_` prefix and silently drops user variables
  that use it. Never log payloads; they carry end-user data.
- **Schemas:** functions publish sdk-go's flattened type schema (sdk-go #14
  array keys, Go type spellings). The SDK reads Zod 3 internals, so users
  must use the `z` the SDK re-exports (DIB-1042 tracks Zod 4).
- **Cancellation** is an `AbortSignal` wherever sdk-go takes a `context`.
- **The proto is embedded** in `src/internal/grpc/proto.ts`, and a test keeps
  it identical to `src/proto/events.proto`. Don't load files at runtime: the
  package ships only `dist/`.
- **Dev-cluster testing:** `devtest/` deploys the conformance worker to dev
  from the packed tarball. Read [devtest/README.md](devtest/README.md) before
  using it, especially the rule about running only one worker per function
  name (DIB-1039).
