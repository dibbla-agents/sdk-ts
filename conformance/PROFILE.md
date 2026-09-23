# Conformance worker profile

Every SDK under test ships a worker that implements exactly this profile. The
scenarios in `scenarios/` drive that worker over the wire and pin what it sends
back, so a behaviour listed here is a behaviour the fixtures depend on. Change
it here first, then in every worker.

## Launch contract

The runner starts the worker as a child process with these environment
variables, and nothing else from the parent environment that could change
behaviour:

| Variable | Meaning |
| --- | --- |
| `GRPC_SERVER_ADDRESS` | `127.0.0.1:<port>` of the runner's fake workflow server (plaintext) |
| `SERVER_NAME` | `conformance-worker` |
| `SERVER_API_TOKEN` | `conformance-token`, unless a scenario unsets it |
| `SERVER_ORG_ID` | set by scenarios that pin an organization |
| `DIBBLA_IDENTITY_TOKEN_FILE` | set by workload-identity scenarios |
| `CONFORMANCE_PING_INTERVAL_SEC` | ping interval; `0` (the default here) disables pings |

The worker reads the first five the way it would in production, which is part
of what is under test. It runs from an empty temporary directory so no `.env`
file is picked up. It must exit when stdin closes or on SIGTERM.

## Functions

All functions are version `1.0.0`.

### `echo` — "Echo the input back"

Simple function, tags `["conformance"]`. Input and output have the same shape:

| Field | Type |
| --- | --- |
| `text` | string |
| `count` | integer |
| `ratio` | float |
| `flag` | boolean |
| `tags` | array of string |
| `items` | array of `{ name: string, qty: integer }` |
| `attrs` | map of string to string |
| `nested` | `{ inner: string }` |

Returns its input unchanged.

### `fail` — "Always fails"

Simple function, input `{ text: string }`, output `{ text: string }`. Always
fails with the error message `boom`.

### `whoami` — "Report the verified caller"

Simple function that reads the platform-asserted caller (sdk-go
`CallerFromContext`). Input `{ query: string }`. Output:

| Field | Value |
| --- | --- |
| `present` | whether the platform asserted a caller |
| `is_user` | `Caller.IsUser()` |
| `identity`, `user_id`, `email`, `name`, `org_id`, `org_role` | the caller's fields, `""` when absent |

### `cached_upper` — "Upper-case with a 60s cache"

Function with a cache TTL of 60 seconds. Input `{ text: string }`, output
`{ text: string }` where `text` is upper-cased.

### `store_append` — "Append to a per-workflow history"

Function. Input `{ text: string }`, output `{ history: string[] }`.

1. Reads store key `history` in the invocation's workflow. A missing, empty or
   undecodable value counts as an empty list.
2. Appends `text`.
3. Writes the list back as a JSON array under the same key.
4. Returns the list.

### `oauth_token` — "Fetch a Google access token"

Function. Input `{ text: string }` (ignored). Requests an OAuth access token
for provider `google` using the invocation's run id. Output
`{ access_token, token_type, provider }` from the token response. An OAuth
error fails the function with the SDK's OAuth error as the message.

### `oauth_status` — "List connected OAuth providers"

Function. Input `{ text: string }` (ignored). Requests the OAuth status for
the invocation's run. Output `{ providers: string[] }`: the names of the
providers whose status says `connected`, sorted.

### `rpc_echo` — "Call echo on another worker"

Function. Input `{ text: string }`. Calls function `echo` version `1.0.0` on
server `other-worker` through the SDK's RPC client, as execution node
`rpc-node` of type `function`, with payload `{ "text": <text> }` and a one
minute timeout. Output `{ reply: string }`: the raw response payload as text.

### `status_ping` — "Send a status message"

Function. Input `{ text: string }`. Sends a status message with text `working`
and JSON payload `{"step": 1}` for the current invocation, then returns
`{ "ok": true }`.

## Capability providers

Registered in this order.

| Seat | Name | Version | Description |
| --- | --- | --- | --- |
| `tool_search` | `reverse` | `1.0.0` | Reverse the offered stubs |
| `tool_search` | `ports` | `1.0.0` | Filter stubs by a wired prefix |
| `tool_search` | `inert` | `1.0.0` | Registered without a handler |
| `memory` | `marker` | `1.0.0` | Inject a marker turn and the last turn |
| `memory` | `blocking` | `1.0.0` | Block until the call is cancelled |

- `reverse`: positional select handler. If the query is `error`, fails with
  `kaboom`. Otherwise returns the offered stub names in reverse order, capped
  at `top_n`.
- `ports`: struct-shaped select handler with
  - extra inputs schema `{"type":"object","properties":{"prefix":{"type":"string"}}}`
  - extra outputs schema `{"type":"object","properties":{"count":{"type":"integer"}}}`

  Selects, in offered order, the stubs whose name starts with the string
  extra input `prefix` (missing = `""`), and returns extra output `count` =
  number selected.
- `inert`: no handler. Registered so it can be bound; calls must be answered
  with the SDK's "not implemented" error.
- `marker`: struct-shaped transform handler, `max_history_fraction` `0.5`,
  extra inputs schema `{"type":"object","properties":{"note":{"type":"string"}}}`.
  Returns two turns:
  1. `{ "id": "marker", "role": "assistant", "date": "2026-01-01T00:00:00Z", "parts": [{ "type": "text", "text": { "text": "<summary>" } }] }`
     where `<summary>` is
     `[marker msg=<current_message> org=<thread_meta.org_id> user=<thread_meta.user_id or "none"> budget=<token_budget> turns=<number of turns>]`
  2. the last input turn, unchanged (omitted when there are no turns).

  If the extra input `note` is a string, returns extra output `note` with
  the same value.
- `blocking`: positional transform handler that waits until the call's
  cancellation signal fires, then fails with the cancellation error.

## Jobs

### `count_job` — "Count Job"

Parameters, in order:

| Name | Type | Required | Default |
| --- | --- | --- | --- |
| `limit` | `int` | yes | none |
| `label` | `string` | no | `"items"` |

Execution, with `limit` read as an integer (default 0):

1. log info `starting`
2. if argument `fail` is `true`: log error `failing`, then fail the job with
   `count failed`
3. task started `count`
4. progress `i` of `limit` with message `counting <label>` for `i = 1..limit`
5. task completed
6. log warn `done`
