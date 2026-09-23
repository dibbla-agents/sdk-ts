/**
 * The sdk-ts implementation of the conformance worker profile
 * (../../PROFILE.md), run from source by the conformance runner.
 *
 * Profile parts the SDK cannot express yet are missing here; the scenarios
 * that need them are listed in ../../known-gaps.json.
 */
import * as sdk from '../../../src';
import { z } from 'zod';

const pingInterval = Number(process.env.CONFORMANCE_PING_INTERVAL_SEC ?? '0');

const server = sdk.create({ pingIntervalSec: pingInterval });

const EchoItem = z.object({ name: z.string(), qty: z.number().int() });
const Echo = z.object({
  text: z.string(),
  count: z.number().int(),
  ratio: z.number(),
  flag: z.boolean(),
  tags: z.array(z.string()),
  items: z.array(EchoItem),
  attrs: z.record(z.string()),
  nested: z.object({ inner: z.string() }),
});
const TextIn = z.object({ text: z.string() });
const TextOut = z.object({ text: z.string() });

server.registerFunctions([
  sdk.newSimpleFunction({
    name: 'echo',
    version: '1.0.0',
    description: 'Echo the input back',
    input: Echo,
    output: Echo,
    handler: (input) => input,
    tags: ['conformance'],
  }),
  sdk.newSimpleFunction({
    name: 'fail',
    version: '1.0.0',
    description: 'Always fails',
    input: TextIn,
    output: TextOut,
    handler: () => {
      throw new Error('boom');
    },
  }),
  sdk.newFunction({
    name: 'cached_upper',
    version: '1.0.0',
    description: 'Upper-case with a 60s cache',
    input: TextIn,
    output: TextOut,
    handler: (input) => ({ text: input.text.toUpperCase() }),
    cacheTTLMs: 60_000,
  }),
  sdk.newFunction({
    name: 'store_append',
    version: '1.0.0',
    description: 'Append to a per-workflow history',
    input: TextIn,
    output: z.object({ history: z.array(z.string()) }),
    handler: async (input, event, state) => {
      let history: string[] = [];
      try {
        const data = await state.store!.get(event.workflow, 'history');
        if (data && data.length > 0) {
          const parsed = JSON.parse(data.toString());
          if (Array.isArray(parsed)) history = parsed;
        }
      } catch {
        history = [];
      }
      history.push(input.text);
      await state.store!.set(event.workflow, 'history', Buffer.from(JSON.stringify(history)));
      return { history };
    },
  }),
  sdk.newFunction({
    name: 'oauth_token',
    version: '1.0.0',
    description: 'Fetch a Google access token',
    input: TextIn,
    output: z.object({ access_token: z.string(), token_type: z.string(), provider: z.string() }),
    handler: async (_input, event, state) => {
      const token = await state.oauth!.getAccessToken('google', event.run);
      return { access_token: token.accessToken, token_type: token.tokenType, provider: token.provider };
    },
  }),
  sdk.newFunction({
    name: 'status_ping',
    version: '1.0.0',
    description: 'Send a status message',
    input: TextIn,
    output: z.object({ ok: z.boolean() }),
    handler: async (_input, event, state) => {
      await state.rpc!.sendStatusEvent(event, 'working', { step: 1 });
      return { ok: true };
    },
  }),
]);

// Not expressible in this SDK version: whoami (no caller API), the five
// capability providers, and count_job.

server.start().catch((err) => {
  console.error(err);
  process.exit(1);
});
