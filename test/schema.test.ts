import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { z } from 'zod';
import { zodToFlattenedSchema } from '../src/internal/utils/schema';

describe('flattened type schema', () => {
  it('describes the conformance echo shape exactly as sdk-go does', () => {
    const schema = z.object({
      text: z.string(),
      count: z.number().int(),
      ratio: z.number(),
      flag: z.boolean(),
      tags: z.array(z.string()),
      items: z.array(z.object({ name: z.string(), qty: z.number().int() })),
      attrs: z.record(z.string()),
      nested: z.object({ inner: z.string() }),
    });
    assert.deepEqual(zodToFlattenedSchema(schema), {
      text: 'string',
      count: 'int',
      ratio: 'float64',
      flag: 'bool',
      tags: '[]string',
      items: '[]object',
      'items[].name': 'string',
      'items[].qty': 'int',
      'attrs[map]': 'map[string]string',
      'nested.inner': 'string',
    });
  });

  // sdk-go #14: every key the schema advertises must be a key the decoder
  // reads. An array advertised only as "kinds[]" was never read, because the
  // decoder (json.Unmarshal there, Zod here) goes by the field name.
  it('declares arrays under the key the decoder reads (sdk-go #14)', () => {
    const input = z.object({ kinds: z.array(z.string()).optional(), scopes: z.array(z.string()).optional(), limit: z.number().int().optional() });
    const schema = zodToFlattenedSchema(input);
    assert.equal(schema.kinds, '[]string');
    assert.ok(!('kinds[]' in schema), 'the bracketed path is not an input key');
    for (const key of Object.keys(schema)) {
      const decoded = input.parse({ [key]: key === 'limit' ? 1 : ['memory'] });
      assert.ok(Object.keys(decoded).includes(key), `schema publishes ${key}, which the decoder ignores`);
    }
  });

  it('describes nested arrays and arrays of objects like sdk-go', () => {
    // Mirrors sdk-go basefunction TestGetTypeSchema.
    const schema = zodToFlattenedSchema(
      z.object({
        InnerStruct: z.array(z.object({ InnerInnerStructAttribute: z.array(z.object({ InnerInnerStructValue: z.string() })) })),
        NestedArrayField: z.array(z.array(z.string())),
      }),
    );
    assert.equal(schema['InnerStruct[].InnerInnerStructAttribute[].InnerInnerStructValue'], 'string');
    assert.equal(schema.InnerStruct, '[]object');
    assert.equal(schema['InnerStruct[].InnerInnerStructAttribute'], '[]object');
    assert.equal(schema.NestedArrayField, '[][]string');
    assert.equal(schema['NestedArrayField[]'], '[]string');
  });

  it('sees through wrappers that do not change the JSON shape', () => {
    const schema = zodToFlattenedSchema(
      z.object({
        a: z.string().optional(),
        b: z.number().int().nullable().default(1),
        c: z.string().refine((s) => s.length > 0),
        d: z.lazy(() => z.boolean()),
        e: z.string().brand<'Id'>(),
        f: z.array(z.object({ g: z.string() })).optional(),
      }),
    );
    assert.deepEqual(schema, { a: 'string', b: 'int', c: 'string', d: 'bool', e: 'string', f: '[]object', 'f[].g': 'string' });
  });

  it('uses the input side of a pipeline for inputs and the output side for outputs', () => {
    const pipe = z.object({ n: z.string().pipe(z.coerce.number().int()) });
    assert.equal(zodToFlattenedSchema(pipe, 'input').n, 'string');
    assert.equal(zodToFlattenedSchema(pipe, 'output').n, 'int');
  });

  it('spells other types the way Go prints them', () => {
    enum Color {
      Red,
      Green,
    }
    const schema = zodToFlattenedSchema(
      z.object({
        big: z.bigint(),
        when: z.date(),
        any: z.any(),
        either: z.union([z.string(), z.number()]),
        kind: z.enum(['a', 'b']),
        color: z.nativeEnum(Color),
        lit: z.literal(3),
        pair: z.tuple([z.string(), z.number()]),
        byId: z.map(z.string(), z.number().int()),
        meta: z.record(z.unknown()),
        set: z.set(z.string()),
      }),
    );
    assert.deepEqual(schema, {
      big: 'int64',
      when: 'time.Time',
      any: 'interface {}',
      either: 'interface {}',
      kind: 'string',
      color: 'int',
      lit: 'int',
      pair: '[]interface {}',
      'byId[map]': 'map[string]int',
      'meta[map]': 'map[string]interface {}',
      set: '[]string',
    });
  });

  it('describes a non-object schema under "type"', () => {
    assert.deepEqual(zodToFlattenedSchema(z.string()), { type: 'string' });
    assert.deepEqual(zodToFlattenedSchema(z.array(z.number())), { type: '[]float64' });
  });
});

describe('flattened type schema: combined objects', () => {
  it('publishes the fields of intersections and object unions, not a single "type" slot', () => {
    const both = z.object({ a: z.string() }).and(z.object({ b: z.number().int() }));
    assert.deepEqual(zodToFlattenedSchema(both), { a: 'string', b: 'int' });
    const either = z.union([z.object({ a: z.string() }), z.object({ c: z.boolean() })]);
    assert.deepEqual(zodToFlattenedSchema(either), { a: 'string', c: 'bool' });
    const tagged = z.discriminatedUnion('kind', [z.object({ kind: z.literal('x'), x: z.string() }), z.object({ kind: z.literal('y'), y: z.string() })]);
    assert.deepEqual(zodToFlattenedSchema(tagged), { kind: 'string', x: 'string', y: 'string' });
    assert.deepEqual(zodToFlattenedSchema(z.object({ list: z.array(both) })), { list: '[]object', 'list[].a': 'string', 'list[].b': 'int' });
    assert.deepEqual(zodToFlattenedSchema(z.object({ v: z.union([z.string(), z.number()]) })), { v: 'interface {}' });
  });
});
