# Dibbla SDK for TypeScript

A TypeScript SDK for building workflow functions with gRPC communication and automatic TLS support.

## Architecture

This SDK mirrors the Go SDK with idiomatic TypeScript patterns:

- **Root Package**: Public API for building workflow functions
- **Internal**: Private implementation details - gRPC communication, state management, and function infrastructure

## Quick Start

### Prerequisites

- Node.js 20 or later. This is a server-side worker SDK built on
  `@grpc/grpc-js`; it does not run in browsers.
- Access to a gRPC workflow server

### Installation

```bash
npm install @dibbla/sdk-ts
```

The package ships CommonJS and ES modules with type declarations. Define
schemas with the `z` it re-exports: the SDK reads Zod 3 schemas to publish
your functions' types, and `npm install zod` would give you Zod 4.

### Example Usage

Create a simple worker with custom functions:

```typescript
import * as sdk from '@dibbla/sdk-ts';
import { z } from '@dibbla/sdk-ts';

// Define input/output schemas with Zod
const GreetingInput = z.object({
  name: z.string(),
});

const GreetingOutput = z.object({
  message: z.string(),
});

async function main() {
  // Create server with minimal configuration
  // (defaults to grpc.dibbla.com:443 with TLS enabled)
  const server = sdk.create({
    serverName: 'my-custom-worker',
    serverApiToken: process.env.SERVER_API_TOKEN,
  });

  // Register a simple function
  const greetingFn = sdk.newSimpleFunction({
    name: 'greeting',
    version: '1.0.0',
    description: 'Generate a greeting message',
    input: GreetingInput,
    output: GreetingOutput,
    handler: (input) => ({
      message: `Hello, ${input.name}!`,
    }),
    // tags: ['utility', 'greeting'], // Optional - not used in most cases
  });

  server.registerFunction(greetingFn);

  // Or register multiple functions at once:
  // server.registerFunctions([greetingFn, otherFn, anotherFn]);

  // Start the worker: runs until server.stop()
  console.log('Starting worker...');
  await server.start();
}

main().catch(console.error);
```

## Configuration

### Environment Variables

| Variable                        | Default               | Description                                                                 |
| ------------------------------- | --------------------- | --------------------------------------------------------------------------- |
| `SERVER_NAME`                   | `codex-ts-worker`     | Unique identifier for this worker                                           |
| `GRPC_SERVER_ADDRESS`           | `grpc.dibbla.com:443` | Address of the workflow server                                              |
| `SERVER_API_TOKEN`              | _(empty)_             | API token. When set, it wins over a workload identity token                 |
| `DIBBLA_IDENTITY_TOKEN_FILE`    | _(set by platform)_   | Workload identity token file; see [Authentication](#authentication)         |
| `SERVER_ORG_ID`                 | _(empty)_             | Pin registration to one organization (sent as `x-org-id`)                   |
| `GRPC_USE_TLS`                  | _(auto-detect)_       | Enable/disable TLS (`true`, `false`, or empty)                              |
| `GRPC_TLS_INSECURE_SKIP_VERIFY` | `false`               | Skip server certificate verification (insecure; self-signed servers only)   |
| `GRPC_KEEPALIVE_TIME_SEC`       | `300`                 | HTTP/2 keepalive ping interval; see [Connection](#robust-connection-management) |
| `GRPC_KEEPALIVE_TIMEOUT_SEC`    | `20`                  | HTTP/2 keepalive ack timeout                                                |
| `SDK_LOG_LEVEL`              | `info`                | SDK log level: `debug`, `info`, `warn`, `error` or `silent`                 |

### Authentication

- **On the Dibbla platform, no configuration is needed.** The platform mounts a
  workload identity token and sets `DIBBLA_IDENTITY_TOKEN_FILE`. The SDK
  presents it and re-reads it at every (re)connect, so token rotation just
  works. `/var/run/secrets/dibbla/identity/token` is also probed.
- **Everywhere else**, set `SERVER_API_TOKEN`. An explicit token always wins
  over an identity token.
- If the token's owner belongs to several organizations, set `SERVER_ORG_ID`
  to choose one. The platform verifies membership.

### TLS Configuration

The SDK defaults to `grpc.dibbla.com:443` with TLS enabled. It automatically detects when to use TLS based on the server address:

- **Production addresses** (default: `grpc.dibbla.com:443`): TLS enabled with system certificates
- **Localhost addresses** (`localhost:`, `127.0.0.1:`, `[::1]:`): No TLS (for local development)

#### Explicit TLS Control

```typescript
// Minimal configuration - uses grpc.dibbla.com:443 with TLS (recommended)
const server = sdk.create({
  serverName: 'my-worker',
  serverApiToken: 'your-token',
});

// Local development - uses localhost without TLS
const server = sdk.create({
  serverName: 'my-worker',
  grpcServerAddress: 'localhost:50051',
});

// Force TLS on for localhost (advanced)
const server = sdk.create({
  serverName: 'my-worker',
  grpcServerAddress: 'localhost:9090',
  useTLS: true,
});
```

## Creating Custom Functions

The SDK provides two types of functions:

### Simple Functions

For basic input → output transformations:

```typescript
const fn = sdk.newSimpleFunction({
  name: 'my-function',
  version: '1.0.0',
  description: 'A simple function',
  input: MyInputSchema,
  output: MyOutputSchema,
  handler: (input, { caller, signal }) => {
    // Your logic here. caller is the verified user, if any; see below.
    return output;
  },
  tags: ['tag1', 'tag2'], // Optional - see note below
});
```

A failing handler (a thrown error or rejected promise) is reported to the
caller as `Function execution failed: handler error: <message>`.

> **Note on Tags**: The `tags` field is optional and currently not used by most workflow features. It is included for future use cases such as function discovery, filtering, or categorization. You can omit it or leave it as an empty array.

### Advanced Functions

For functions needing access to workflow context:

```typescript
const fn = sdk.newFunction({
  name: 'my-function',
  version: '1.0.0',
  description: 'An advanced function',
  input: MyInputSchema,
  output: MyOutputSchema,
  handler: async (input, event, globalState) => {
    // Access workflow info: event.workflow, event.node, etc.
    // Use cache: globalState.cache?.get(key)
    // Use store: globalState.store?.get(workflowId, key)
    // Use OAuth: globalState.oauth?.getAccessToken('google', event.run)
    return output;
  },
  cacheTTLMs: 5 * 60 * 1000, // 5 minutes
});
```

### Knowing Who Is Calling

A function exposed as a directly callable tool runs on behalf of a person.
When a signed-in user calls it (platform MCP, API or CLI), the platform
asserts who they are. The SDK hands that to simple handlers as
`context.caller`, and advanced handlers can read it with
`sdk.callerFromEvent(event)`:

```typescript
const myNotes = sdk.newSimpleFunction({
  name: 'my_notes',
  version: '1.0.0',
  description: "List the caller's notes",
  input: z.object({ query: z.string() }),
  output: z.object({ notes: z.array(z.string()) }),
  handler: async (input, { caller }) => {
    if (!caller?.isUser()) {
      throw new Error('this function needs a signed-in user');
    }
    return { notes: await notesFor(caller.userId, input.query) };
  },
});
```

`caller` is `null` when the platform asserted no identity, for instance for a
call from inside a workflow run. Treat that as "no user", never as a default
user. The values come from the platform, outside the payload, so an input
field can never impersonate anyone. Never read identity from inputs. Prefer
`userId` as a database key (an email can be reassigned), and in a worker that
serves one organization, reject calls whose `orgId` is not yours.

## Features

### Type-Safe Functions with Zod

- Define input/output schemas using Zod
- Schemas are published to the platform in the same flattened format sdk-go
  uses: `{"tags": "[]string", "items[].name": "string", "nested.inner": "string"}`.
  Arrays are declared under the key callers send, with `[]` describing the
  elements of object arrays.
- Runtime validation of inputs and outputs. Keys not in the output schema are
  dropped before the response is sent.
- `z.bigint()`, `z.date()`, `z.set()` and `z.map()` work on both sides: they
  arrive as JSON numbers, RFC 3339 strings, arrays and objects, and are sent
  back the same way. Integers beyond 2^53 lose precision in JSON parsing, as
  in any JavaScript; send such ids as strings.
- Full TypeScript type inference

### Built-in Caching

- Per-function cache TTL configuration (`cacheTTLMs`; whole seconds on the wire)
- Cache keys are MurmurHash3 over the payload bytes, function name and version,
  identical to sdk-go's
- gRPC-based distributed cache. A cache that doesn't answer counts as a miss

### OAuth Access Tokens

The SDK provides OAuth token management that allows your functions to call external APIs on behalf of users. When a user connects their account (e.g., Google, Microsoft) through the workflow UI, your functions can retrieve valid access tokens to make API calls.

#### How It Works

1. **User connects their account** in the workflow UI (handled by the platform)
2. **Your function requests a token** using `globalState.oauth?.getAccessToken(provider, runId)`
3. **The SDK returns a fresh token** (automatically refreshed if expired)
4. **You use the token** to call external APIs with the user's permissions

#### Basic Usage

```typescript
const fn = sdk.newFunction({
  name: 'call_google_api',
  version: '1.0.0',
  description: 'Calls a Google API on behalf of the user',
  input: MyInputSchema,
  output: MyOutputSchema,
  handler: async (input, event, globalState) => {
    // Get an access token for Google. Throws sdk.OAuthError when the user
    // has not connected the provider, sdk.TimeoutError if no answer comes.
    const token = await globalState.oauth!.getAccessToken('google', event.run);

    // Use the token to call Google APIs
    // token.accessToken - the bearer token
    // token.tokenType   - typically "Bearer"
    // token.expiresAt   - Unix timestamp when token expires

    return output;
  },
});
```

#### Token Response Object

| Property | Type | Description |
|----------|------|-------------|
| `accessToken` | `string` | The OAuth bearer token to use in API calls |
| `tokenType` | `string` | Token type, typically `"Bearer"` |
| `expiresAt` | `number` | Unix timestamp (seconds) when the token expires |
| `provider` | `string` | The provider name (`"google"`, `"microsoft"`, `"github"`) |

#### Checking Connected Providers

You can check which providers a user has connected before attempting to get tokens:

```typescript
const providers = await globalState.oauth?.getConnectedProviders(event.run);
// Returns: { google: { connected: true, email: "user@gmail.com", ... }, ... }

if (!providers?.google?.connected) {
  throw new Error('Please connect your Google account to use this feature');
}
```

#### Supported Providers

| Provider | API Access |
|----------|------------|
| `google` | Gmail, Calendar, Drive, Sheets, Docs, and all Google Workspace APIs |
| `microsoft` | Outlook, OneDrive, Teams, SharePoint, and Microsoft Graph APIs |
| `github` | Repositories, Issues, Pull Requests, and GitHub REST/GraphQL APIs |

---

## Tutorial: Building a Google Sheets Integration

This tutorial walks through building a function that reads data from Google Sheets. It demonstrates OAuth tokens, external API calls, and status messages working together.

### Step 1: Define Your Schemas

Start by defining the input and output schemas with Zod:

```typescript
import * as sdk from '@dibbla/sdk-ts';
import { z } from '@dibbla/sdk-ts';

// Input: just the Google Sheets URL
const ReadSheetsInput = z.object({
  url: z.string().describe('Google Sheets URL (e.g., https://docs.google.com/spreadsheets/d/1abc.../edit)'),
});

// Output: the spreadsheet data
const ReadSheetsOutput = z.object({
  title: z.string().describe('Spreadsheet title'),
  data: z.array(z.array(z.string())).describe('2D array of cell values'),
  rowCount: z.number().describe('Number of rows'),
});
```

### Step 2: Parse the Spreadsheet ID

Google Sheets URLs contain a spreadsheet ID that we need to extract:

```typescript
function parseSpreadsheetId(url: string): string {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) {
    throw new Error('Invalid Google Sheets URL');
  }
  return match[1];
}
```

### Step 3: Build the Function

Now create the function that ties everything together:

```typescript
export const readGoogleSheetsFn = sdk.newFunction({
  name: 'read_google_sheets',
  version: '1.0.0',
  description: 'Read data from a Google Sheets spreadsheet',
  input: ReadSheetsInput,
  output: ReadSheetsOutput,
  handler: async (input, event, state) => {
    // 1. Send initial status message
    await state.rpc?.sendStatusEvent(event, 'Connecting to Google Sheets...', {
      url: input.url,
    });

    // 2. Check OAuth is available
    if (!state.oauth) {
      throw new Error('OAuth not available');
    }

    // 3. Get the user's Google access token
    const token = await state.oauth.getAccessToken('google', event.run);
    
    // 4. Parse the spreadsheet ID from the URL
    const spreadsheetId = parseSpreadsheetId(input.url);

    // 5. Send progress update
    await state.rpc?.sendStatusEvent(event, 'Reading spreadsheet data...', {
      spreadsheetId,
    });

    // 6. Call Google Sheets API
    const apiUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?includeGridData=true`;
    
    const response = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${token.accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google Sheets API error: ${error}`);
    }

    const spreadsheet = await response.json();

    // 7. Extract cell data from the first sheet
    const sheet = spreadsheet.sheets[0];
    const rows = sheet.data[0].rowData || [];
    const data: string[][] = rows.map((row: any) => 
      (row.values || []).map((cell: any) => cell.formattedValue || '')
    );

    // 8. Send completion status
    await state.rpc?.sendStatusEvent(event, 'Successfully read spreadsheet', {
      title: spreadsheet.properties.title,
      rowCount: data.length,
    });

    // 9. Return the result
    return {
      title: spreadsheet.properties.title,
      data,
      rowCount: data.length,
    };
  },
});
```

### Step 4: Register and Run

```typescript
async function main() {
  const server = sdk.create({
    serverName: 'sheets-worker',
    serverApiToken: process.env.SERVER_API_TOKEN,
  });

  server.registerFunction(readGoogleSheetsFn);

  console.log('Starting Google Sheets worker...');
  await server.start();
}

main().catch(console.error);
```

### Key Takeaways

1. **Always check for OAuth availability** before attempting to get tokens
2. **Use status messages** to provide feedback during long operations
3. **Handle API errors gracefully** with meaningful error messages
4. **The access token is automatically refreshed** - you don't need to handle token expiration

### Complete Examples

See the `examples/` directory for full working examples:

- `examples/google-sheets-worker.ts` - Complete Google Sheets read/write
- `examples/oauth-example-worker.ts` - OAuth token retrieval for multiple providers
- `examples/ts-sdk-examples-worker.ts` - Modular worker with all functions

---

## Organizing Functions in Modules

For larger projects, organize your functions into separate files and use a minimal entry point. This keeps your codebase clean and makes it easy to see the overall structure.

### Project Structure

```
my-worker/
├── functions/
│   ├── index.ts          # Exports all functions
│   ├── sheets.ts         # Google Sheets functions
│   ├── email.ts          # Email functions
│   └── utils.ts          # Utility functions
├── main.ts               # Minimal entry point
└── package.json
```

### Function Module (`functions/sheets.ts`)

Each module exports its function definitions:

```typescript
import * as sdk from '@dibbla/sdk-ts';
import { z } from '@dibbla/sdk-ts';

const ReadSheetsInput = z.object({
  url: z.string(),
});

const ReadSheetsOutput = z.object({
  data: z.array(z.array(z.string())),
});

export const readSheetsFn = sdk.newFunction({
  name: 'read_sheets',
  version: '1.0.0',
  description: 'Read from Google Sheets',
  input: ReadSheetsInput,
  output: ReadSheetsOutput,
  handler: async (input, event, state) => {
    // ... implementation
  },
});
```

### Barrel File (`functions/index.ts`)

Re-export all functions and provide a convenience array:

```typescript
export { readSheetsFn, writeSheetsFn } from './sheets';
export { sendEmailFn } from './email';
export { formatDateFn, parseJsonFn } from './utils';

// Import for the `all` array
import { readSheetsFn, writeSheetsFn } from './sheets';
import { sendEmailFn } from './email';
import { formatDateFn, parseJsonFn } from './utils';

// All functions for bulk registration
export const all = [
  readSheetsFn,
  writeSheetsFn,
  sendEmailFn,
  formatDateFn,
  parseJsonFn,
];
```

### Minimal Entry Point (`main.ts`)

The entry point becomes remarkably concise:

```typescript
import 'dotenv/config';
import * as sdk from '@dibbla/sdk-ts';
import * as functions from './functions';

async function main() {
  const server = sdk.create({
    serverName: process.env.SERVER_NAME || 'my-worker',
    serverApiToken: process.env.SERVER_API_TOKEN,
  });

  // Register all functions at once
  server.registerFunctions(functions.all);

  console.log(`Starting worker with ${functions.all.length} functions...`);
  await server.start();
}

main().catch(console.error);
```

### Benefits

- **Separation of concerns** - Each domain has its own file
- **Easy to navigate** - The entry point shows the full picture
- **Testable** - Functions can be unit tested in isolation
- **Scalable** - Add new functions without touching the entry point

---

### Capability Providers

A capability provider replaces a built-in agent capability for the agent
nodes that bind it. Providers are announced with your functions but never
appear as functions.

**Tool search** chooses which tools an agent gets for a query. You select from
the offered candidates; you never add tools:

```typescript
server.registerCapabilityProvider(
  sdk.toolSearchProvider({
    name: 'keyword-scorer',
    description: 'Ranks tools by keyword overlap',
    version: '1.0.0',
    select: (query, stubs, topN) =>
      stubs
        .map((s) => ({ name: s.name, score: overlap(query, `${s.name} ${s.description ?? ''}`) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topN)
        .map((s) => s.name),
  }),
);
```

**Memory** decides which conversation history the model sees, under an
enforced token budget. The platform keeps custody of the stored history: what
you return is used for that one run and never written back.

```typescript
server.registerCapabilityProvider(
  sdk.memoryProvider({
    name: 'recent-only',
    description: 'Keeps the last few turns',
    version: '1.0.0',
    maxHistoryFraction: 0.5,
    transform: async (currentMessage, turns, tokenBudget, meta, signal) => {
      // meta.org_id / meta.user_id are asserted by the engine: safe to
      // partition storage on. meta.thread_id is caller-supplied: never a boundary.
      return turns.slice(-6);
    },
  }),
);
```

- Throwing fails the agent node; there is no fallback to the built-in behaviour.
- Calls have a hard budget of about 15 seconds. When the engine abandons a call
  (timeout, run terminated), `signal` aborts: stop work, and above all don't
  commit side effects nobody will read.
- To declare extra node ports, pass `extraInputsSchema` / `extraOutputsSchema`
  and use `selectFull` / `transformFull`, which receive `extraInputs` and may
  return `extraOutputs`. Registration fails if ports are declared with only
  the positional handler.
- The memory seat sends full conversation content (text, tool arguments and
  results, reasoning) to your worker.

### Jobs

Jobs are long-running work the platform triggers, such as pipeline tasks.
Unlike functions they report progress while they run:

```typescript
server.registerJob(
  sdk.newJob({
    id: 'sync_contacts',
    name: 'Sync contacts',
    parameters: [
      { name: 'limit', type: 'int', required: true },
      { name: 'source', type: 'string', required: false, default: 'crm' },
    ],
    async execute(ctx) {
      const limit = ctx.getIntArg('limit', 100);
      ctx.logger.info(`syncing up to ${limit} contacts`);

      ctx.logger.taskStarted('fetch');
      for (let i = 1; i <= limit; i++) {
        // ...
        ctx.logger.progress(i, limit, 'fetching');
      }
      ctx.logger.taskCompleted();
      // Throwing fails the run with the error's message.
    },
  }),
);
```

Jobs are announced on connect and again after every reconnect. The logger
sends `log_message`, `task_*` and `progress_update` events for the run, and the
SDK sends `job_started`, `job_completed` or `job_failed` around `execute`.

When a job calls a workflow, stamp the request with `sdk.originHeaders(ctx)`.
That ties the resulting run to the current pipeline task, so the platform can
show which task made which calls:

```typescript
ctx.logger.taskStarted('GenerateSentiment');
const origin = sdk.originHeaders(ctx); // once per task, after taskStarted
await fetch(workflowUrl, { method: 'POST', headers: { ...origin, 'Content-Type': 'application/json' }, body });
```

### Status Messages

Send real-time status updates to the workflow UI during function execution. This is useful for long-running tasks to provide progress feedback to users.

#### How It Works

Status messages are sent via the gRPC stream as `status_message` events. They are routed using the correlation ID from the original function request, allowing the workflow server to associate the status update with the correct execution context.

The status message contains:
- **text**: A human-readable message displayed in the UI
- **payload**: Optional structured JSON data for detailed progress information

#### Usage

```typescript
const fn = sdk.newFunction({
  name: 'process_data',
  version: '1.0.0',
  description: 'Process data with progress updates',
  input: MyInputSchema,
  output: MyOutputSchema,
  handler: async (input, event, globalState) => {
    // Send initial status
    await globalState.rpc?.sendStatusEvent(event, 'Starting data processing...', {
      progress: 0,
    });

    // ... do some work ...

    // Send progress update with optional payload
    await globalState.rpc?.sendStatusEvent(event, 'Processing 50% complete', {
      progress: 50,
      itemsProcessed: 500,
    });

    // ... do more work ...

    // Send completion status
    await globalState.rpc?.sendStatusEvent(event, 'Processing complete!', {
      progress: 100,
      totalItems: 1000,
    });

    return output;
  },
});
```

#### Method Signature

```typescript
await globalState.rpc?.sendStatusEvent(event, text, payload?);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `event` | `EventMessage` | The event message from the handler (required for routing via correlation ID) |
| `text` | `string` | A human-readable status message |
| `payload` | `unknown` | Optional JSON-serializable data for structured progress info |

> **Note**: Status messages are fire-and-forget; the function does not wait for acknowledgment. If the gRPC connection is lost, the status message may not be delivered.

### Key-Value Store

Store and retrieve data associated with workflows:

```typescript
// Get a value: null when there is none
const value = await globalState.store?.getString(event.workflow, 'my-key');

// Set a value
await globalState.store?.setString(event.workflow, 'my-key', 'my-value');
```

A read that gets no answer in time throws `sdk.TimeoutError` instead of
returning `null`, so a read-modify-write never overwrites data it didn't see.
Requests that wait for an answer (store and cache reads, OAuth, RPC) accept
`{ timeoutMs, signal }`; the default timeout is 30 seconds.

### Robust Connection Management

- **Automatic reconnection.** Retries start at `grpcReconnectIntervalSec` (5s)
  and double up to 5 minutes, with jitter so a fleet doesn't reconnect in
  lockstep. A connection that stays up for a minute resets the backoff.
- **Re-registration.** After every reconnect the worker registers its
  functions again, because the server has forgotten it.
- **Rejected credentials don't cause a retry storm.** An `Unauthenticated` or
  `PermissionDenied` stream goes straight to the 5-minute cadence, unless the
  identity token file has rotated since, in which case the new token is tried
  promptly.
- **Dead-connection detection.** HTTP/2 keepalive pings every 5 minutes. Don't
  go below that when dialing a gRPC server directly: servers answer faster
  pings with GOAWAY `too_many_pings`. Behind a proxy that answers pings itself
  (e.g. Traefik), 30 seconds is safe.
- Application-level ping every `pingIntervalSec` (30s; 0 disables).
- `server.stop()` disconnects and makes `start()` return.

### Function Tags

Functions can include an optional `tags` array for categorization:

```typescript
const fn = sdk.newSimpleFunction({
  // ...
  tags: ['utility', 'math'],
});
```

> **Note**: Tags are currently not used by most workflow features. They are sent to the workflow server during function registration but have no effect on routing or execution. They are reserved for future use cases such as:
> - Function discovery and search
> - UI filtering and grouping
> - Access control policies
>
> You can safely omit the `tags` field or leave it as an empty array.

## Troubleshooting

### Common Issues

**Connection Failures**: 
- By default, the SDK connects to `grpc.dibbla.com:443` with TLS enabled
- For local development, set `GRPC_SERVER_ADDRESS=localhost:50051`
- Verify your server address points to a running workflow server
- Check TLS configuration matches your server setup

**Authentication Errors**: 
- Ensure `SERVER_API_TOKEN` is set if the server requires authentication
- Check token is valid and not expired
- After a rejection the worker retries every ~5 minutes; restart it after fixing the token to reconnect at once

**TLS Certificate Errors**:
- Ensure system CA certificates are up to date
- For self-signed certificates, set `GRPC_TLS_INSECURE_SKIP_VERIFY=true` (the connection stays encrypted but the server is not verified; never in production)

### Debug Mode

Set `SDK_LOG_LEVEL=debug` to log every event sent and received. Payloads are
never logged: they carry end-user data.

## License

Part of the Dibbla project.

