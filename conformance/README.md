# Wire conformance suite

The Dibbla worker protocol is one bidirectional gRPC stream carrying an untyped
envelope. Everything that matters (event names, payload shapes, which fields
are set, reconnect and auth behaviour) lives in strings and JSON, so nothing
in the proto fails when two SDKs disagree. This suite pins that behaviour as
language-neutral fixtures and runs every SDK against the same ones.

sdk-go is the reference. **The Go worker must pass every scenario.** A
scenario Go fails is a wrong scenario, not a Go bug to wave through. If Go's
behaviour changes deliberately, the scenario changes in the same pull request.

## How it works

```
 scenarios/*.json ──► runner (TypeScript, fake EventService on 127.0.0.1:<port>)
                           │  spawns one worker process per scenario
                           ▼
          workers/go (real sdk-go)   or   workers/ts (this SDK, from source)
```

Both workers implement the same profile ([PROFILE.md](PROFILE.md)): the same
functions, providers and job, with the same observable behaviour. Each
scenario plays the server side of a conversation and pins what the worker
sends back, down to which envelope fields are empty.

## Running

```sh
npm run conformance        # this SDK
npm run conformance:go     # sdk-go at the version in workers/go/go.mod (needs Go)

SDK_GO_DIR=../sdk-go npm run conformance:go   # sdk-go from a local checkout
CONFORMANCE_ONLY=reconnect,store npm run conformance   # a subset

npm run build && npm run conformance:packed   # this SDK as published (require and import)
```

`conformance:go` builds the Go worker once per run. `SDK_GO_DIR` builds it
against a local checkout through a temporary modfile, without touching the
committed `go.mod`. That is how sdk-go's CI can run these fixtures against its
own HEAD.

`conformance:packed` packs the built package, installs the tarball into a
scratch project, and runs the TS worker against it twice: once loaded with
`require` and once with `import`. That tests the `files` list, the `exports`
map and both builds, which running from source cannot.

## Known gaps

[known-gaps.json](known-gaps.json) lists, per worker, the scenarios that are
expected to fail and why. A listed scenario is reported as a todo instead of
a failure. If a listed scenario starts passing, the run fails until the entry
is removed, so the list only shrinks. The `go` list must stay empty.

## Scenario format

A scenario is `scenarios/<name>.json`; the file name and `name` must agree.

```json
{
  "name": "reconnect",
  "description": "What behaviour this pins and why it matters.",
  "worker": {
    "env": { "SERVER_ORG_ID": "org-1" },
    "unset": ["SERVER_API_TOKEN"],
    "files": { "identity-token": "first-token" }
  },
  "keep_pings": false,
  "steps": [ ... ]
}
```

`worker.files` are written into the scenario's temp directory, which scenarios
reference as `${tmp}`. Pings are dropped from the stream unless `keep_pings`
is set.

### Steps

| Step | Meaning |
| --- | --- |
| `{"accept": {"metadata": {...}}, "timeout_ms": n}` | Wait for the worker to open a stream. Each listed metadata key must match; `null` means the key must be absent. |
| `{"include": "handshake"}` | Splice in `includes/handshake.json`: the full registration sequence every new stream starts with. |
| `{"expect": message, "timeout_ms": n}` | The next message from the worker must match. |
| `{"expect_unordered": [message, ...]}` | The next N messages must match, in any order. |
| `{"expect_none": {"for_ms": n}}` | Nothing may arrive for n ms. |
| `{"expect_no_stream": {"for_ms": n}}` | The worker must not open a new stream for n ms. |
| `{"send": message}` | Send a message to the worker. |
| `{"end_stream": {"code": "UNAUTHENTICATED", "details": "..."}}` | End the current stream with a gRPC status (`OK` closes it cleanly). |
| `{"write_file": {"name": "...", "content": "..."}}` | Rewrite a file in `${tmp}`, e.g. to rotate an identity token. |
| `{"comment": "..."}` | Ignored. |

### Messages

A message has the envelope's string fields (`function`, `node`, `workflow`,
`version`, `server`, `event`, `text`, `run`, `correlation_id`), plus `meta`
(an object, carried as a protobuf Struct) and `payload`, which is one of:
`{"json": value}`, `{"text": "..."}` or `{"base64": "..."}`.

In an expectation, **an omitted field must be empty**: `""`, no meta, no
payload. Absent meta and an empty Struct are the same to a receiver, and so
are an absent and an empty payload. JSON payloads are compared as parsed
values; objects must have exactly the expected keys.

Expected values may use these tokens:

| Token | Matches |
| --- | --- |
| `"$any"` | anything, including an absent key |
| `"$nonempty"` | any non-empty string |
| `"$capture:NAME"` | any non-empty string, remembered as `${NAME}` for later steps |
| `"$prefix:TEXT"`, `"$regex:RE"` | strings by prefix or regular expression |
| `{"$json": value}` | a string holding JSON that matches `value` |
| `{"$unordered": [...]}` | an array with these elements in any order |
| `{"$fragment": "name"}` | the contents of `fragments/name.json` (resolved at load) |

`${worker}` and `${token}` expand to the worker's name and API token.

## What is deliberately not pinned

- **Decoder error text.** A payload that fails to decode is pinned as an error
  event with the SDK's prefix. The decoder's own message (Go's
  `encoding/json`, Zod) is language-specific.
- **Element type names of object arrays in schemas.** Go publishes
  `"items": "[]main.EchoItem"`, which includes its package name. The engine
  keeps only what follows the last `.` and treats every non-primitive name the
  same way, so the fixture pins `[]` followed by a type name.
- **Input validation semantics.** Go decodes leniently (missing fields become
  zero values); a Zod schema can be strict. Scenarios always send complete
  inputs.
- **`time.Time` fields in schemas.** sdk-go recurses into `time.Time`'s
  unexported fields. The profile has no time-typed function fields rather than
  pin that.

## Adding a scenario

1. Write `scenarios/<name>.json` from sdk-go's behaviour, read from its source.
2. Run `npm run conformance:go`. It must pass. When it doesn't, the scenario
   is wrong or the profile is ambiguous; fix the scenario, never the Go worker.
3. Run `npm run conformance`. If this SDK fails, fix the SDK, or add the
   scenario to `known-gaps.json` with the reason and the slice that will fix it.

If the scenario needs worker behaviour the profile doesn't have, extend
[PROFILE.md](PROFILE.md) and both workers in the same change.
