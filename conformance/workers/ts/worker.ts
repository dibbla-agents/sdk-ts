/**
 * The sdk-ts implementation of the conformance worker profile
 * (../../PROFILE.md), run from source by the conformance runner.
 *
 * Scenarios this SDK does not pass yet are listed in ../../known-gaps.json.
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
  sdk.newSimpleFunction({
    name: 'whoami',
    version: '1.0.0',
    description: 'Report the verified caller',
    input: z.object({ query: z.string() }),
    output: z.object({
      present: z.boolean(),
      is_user: z.boolean(),
      identity: z.string(),
      user_id: z.string(),
      email: z.string(),
      name: z.string(),
      org_id: z.string(),
      org_role: z.string(),
    }),
    handler: (_input, { caller }) => ({
      present: caller !== null,
      is_user: caller?.isUser() ?? false,
      identity: caller?.identity ?? '',
      user_id: caller?.userId ?? '',
      email: caller?.email ?? '',
      name: caller?.name ?? '',
      org_id: caller?.orgId ?? '',
      org_role: caller?.orgRole ?? '',
    }),
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

server.registerJob(
  sdk.newJob({
    id: 'count_job',
    name: 'Count Job',
    parameters: [
      { name: 'limit', type: 'int', required: true },
      { name: 'label', type: 'string', required: false, default: 'items' },
    ],
    execute: (ctx) => {
      const limit = ctx.getIntArg('limit', 0);
      const label = ctx.getStringArg('label', 'items');

      ctx.logger.info('starting');
      if (ctx.getBoolArg('fail', false)) {
        ctx.logger.error('failing');
        throw new Error('count failed');
      }

      ctx.logger.taskStarted('count');
      for (let i = 1; i <= limit; i++) {
        ctx.logger.progress(i, limit, `counting ${label}`);
      }
      ctx.logger.taskCompleted();
      ctx.logger.warn('done');
    },
  }),
);

server.registerCapabilityProvider(
  sdk.toolSearchProvider({
    name: 'reverse',
    description: 'Reverse the offered stubs',
    version: '1.0.0',
    select: (query, stubs, topN) => {
      if (query === 'error') throw new Error('kaboom');
      return stubs.map((s) => s.name).reverse().slice(0, topN);
    },
  }),
);
server.registerCapabilityProvider(
  sdk.toolSearchProvider({
    name: 'ports',
    description: 'Filter stubs by a wired prefix',
    version: '1.0.0',
    extraInputsSchema: { type: 'object', properties: { prefix: { type: 'string' } } },
    extraOutputsSchema: { type: 'object', properties: { count: { type: 'integer' } } },
    selectFull: ({ stubs, extraInputs }) => {
      const prefix = typeof extraInputs.prefix === 'string' ? extraInputs.prefix : '';
      const selected = stubs.map((s) => s.name).filter((name) => name.startsWith(prefix));
      return { selected, extraOutputs: { count: selected.length } };
    },
  }),
);
server.registerCapabilityProvider(
  sdk.toolSearchProvider({ name: 'inert', description: 'Registered without a handler', version: '1.0.0' }),
);
server.registerCapabilityProvider(
  sdk.memoryProvider({
    name: 'marker',
    description: 'Inject a marker turn and the last turn',
    version: '1.0.0',
    maxHistoryFraction: 0.5,
    extraInputsSchema: { type: 'object', properties: { note: { type: 'string' } } },
    transformFull: ({ currentMessage, turns, tokenBudget, meta, extraInputs }) => {
      const summary =
        `[marker msg=${currentMessage} org=${meta.org_id ?? ''} user=${meta.user_id ?? 'none'} ` +
        `budget=${tokenBudget} turns=${turns.length}]`;
      const out: sdk.Turn[] = [
        { id: 'marker', role: 'assistant', date: '2026-01-01T00:00:00Z', parts: [{ type: 'text', text: { text: summary } }] },
      ];
      if (turns.length > 0) out.push(turns[turns.length - 1]);
      return {
        turns: out,
        extraOutputs: typeof extraInputs.note === 'string' ? { note: extraInputs.note } : undefined,
      };
    },
  }),
);
server.registerCapabilityProvider(
  sdk.memoryProvider({
    name: 'blocking',
    description: 'Block until the call is cancelled',
    version: '1.0.0',
    transform: (_message, _turns, _budget, _meta, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  }),
);

server.start().catch((err) => {
  console.error(err);
  process.exit(1);
});
