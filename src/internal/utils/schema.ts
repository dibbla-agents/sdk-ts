import { ZodTypeAny } from 'zod';

/**
 * Zod schemas → the flattened type schema sdk-go publishes as a function's
 * inputs_type/outputs_type (sdk-go basefunction.getTypeSchema, as of #14).
 *
 * Keys are the JSON names a caller sends, dotted into nested objects; values
 * are Go type spellings, which is what the engine parses:
 *
 *   { "text": "string", "count": "int", "ratio": "float64", "flag": "bool",
 *     "tags": "[]string",                 // an array, under the key the decoder reads
 *     "items": "[]object",                // an array of objects...
 *     "items[].name": "string",           // ...whose elements are described under "[]"
 *     "attrs[map]": "map[string]string",
 *     "nested.inner": "string" }
 *
 * Go names object element types by package ("[]main.Item"); a Zod object has
 * no name, so it is "object". The engine keeps only what follows the last
 * "." and treats every non-primitive name alike.
 *
 * Input schemas describe what a caller sends, output schemas what the
 * handler returns: for a pipeline that is its input and output side
 * respectively.
 */

type Side = 'input' | 'output';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const def = (t: ZodTypeAny): any => t._def;

/** Strips wrappers that do not change the JSON shape. */
function unwrap(t: ZodTypeAny, side: Side): ZodTypeAny {
  for (;;) {
    switch (def(t).typeName) {
      case 'ZodOptional':
      case 'ZodNullable':
      case 'ZodDefault':
      case 'ZodCatch':
      case 'ZodReadonly':
        t = def(t).innerType;
        break;
      case 'ZodBranded':
      case 'ZodPromise':
        t = def(t).type;
        break;
      case 'ZodEffects':
        t = def(t).schema;
        break;
      case 'ZodPipeline':
        t = side === 'input' ? def(t).in : def(t).out;
        break;
      case 'ZodLazy':
        t = def(t).getter();
        break;
      default:
        return t;
    }
  }
}

/** The Go spelling of a type, as reflect.Type.String() would print it. */
function goType(t: ZodTypeAny, side: Side): string {
  t = unwrap(t, side);
  const d = def(t);
  switch (d.typeName) {
    case 'ZodString':
    case 'ZodEnum':
      return 'string';
    case 'ZodNumber':
      return (d.checks ?? []).some((c: { kind: string }) => c.kind === 'int') ? 'int' : 'float64';
    case 'ZodBigInt':
      return 'int64';
    case 'ZodBoolean':
      return 'bool';
    case 'ZodDate':
      return 'time.Time';
    case 'ZodLiteral':
      switch (typeof d.value) {
        case 'string':
          return 'string';
        case 'number':
          return Number.isInteger(d.value) ? 'int' : 'float64';
        case 'boolean':
          return 'bool';
        default:
          return 'interface {}';
      }
    case 'ZodNativeEnum': {
      const values = Object.values(d.values as Record<string, unknown>);
      // TypeScript numeric enums map names back to numbers; the numbers are the values.
      return values.some((v) => typeof v === 'number') ? 'int' : 'string';
    }
    case 'ZodObject':
      return 'object';
    case 'ZodArray':
      return `[]${goType(d.type, side)}`;
    case 'ZodSet':
      return `[]${goType(d.valueType, side)}`;
    case 'ZodTuple':
      return '[]interface {}';
    case 'ZodRecord':
      return `map[string]${goType(d.valueType, side)}`;
    case 'ZodMap':
      return `map[${goType(d.keyType, side)}]${goType(d.valueType, side)}`;
    default:
      // Object-shaped unions and intersections are objects; other unions,
      // any, unknown, null, undefined, ... have no Go equivalent.
      return objectParts(t, side) ? 'object' : 'interface {}';
  }
}

/** The object shapes a type combines into one object, or null if it is not one. */
function objectParts(t: ZodTypeAny, side: Side): ZodTypeAny[] | null {
  t = unwrap(t, side);
  const d = def(t);
  switch (d.typeName) {
    case 'ZodObject':
      return [t];
    case 'ZodIntersection': {
      const left = objectParts(d.left, side);
      const right = objectParts(d.right, side);
      return left && right ? [...left, ...right] : null;
    }
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      // Go has no unions; publish every field any option can carry.
      const options = (d.typeName === 'ZodUnion' ? d.options : Array.from(d.options.values ? d.options.values() : d.options)) as ZodTypeAny[];
      const parts = options.map((o) => objectParts(o, side));
      return parts.every((p) => p !== null) ? parts.flat() as ZodTypeAny[] : null;
    }
    default:
      return null;
  }
}

function buildSchema(t: ZodTypeAny, path: string, result: Record<string, string>, side: Side): void {
  t = unwrap(t, side);
  const parts = def(t).typeName === 'ZodObject' ? null : objectParts(t, side);
  if (parts) {
    for (const part of parts) buildSchema(part, path, result, side);
    return;
  }
  if (def(t).typeName === 'ZodObject') {
    const shape = def(t).shape() as Record<string, ZodTypeAny>;
    for (const [name, field] of Object.entries(shape)) {
      processField(field, path ? `${path}.${name}` : name, result, side);
    }
    return;
  }
  result[path || 'type'] = goType(t, side);
}

function processField(t: ZodTypeAny, path: string, result: Record<string, string>, side: Side): void {
  t = unwrap(t, side);
  if (objectParts(t, side)) {
    buildSchema(t, path, result, side);
    return;
  }
  switch (def(t).typeName) {
    case 'ZodArray':
    case 'ZodSet':
      processArrayField(t, path, result, side);
      return;
    case 'ZodRecord':
    case 'ZodMap':
      result[`${path}[map]`] = goType(t, side);
      return;
    default:
      result[path] = goType(t, side);
  }
}

/**
 * An array is declared under its own key — the key a caller sends — with an
 * array type. The bracketed path only describes what is inside object (or
 * nested array) elements. Declaring the array only at "path[]" advertised a
 * key no decoder reads (sdk-go #14).
 */
function processArrayField(t: ZodTypeAny, path: string, result: Record<string, string>, side: Side): void {
  result[path] = goType(t, side);
  const d = def(t);
  const element = unwrap(d.typeName === 'ZodSet' ? d.valueType : d.type, side);
  const elementPath = `${path}[]`;
  if (objectParts(element, side)) {
    buildSchema(element, elementPath, result, side);
    return;
  }
  switch (def(element).typeName) {
    case 'ZodArray':
    case 'ZodSet':
      processArrayField(element, elementPath, result, side);
      break;
  }
}

/** The flattened type schema of a Zod schema; see the module comment. */
export function zodToFlattenedSchema(schema: ZodTypeAny, side: Side = 'input'): Record<string, string> {
  const result: Record<string, string> = {};
  buildSchema(schema, '', result, side);
  return result;
}

/** The flattened type schema as the JSON string sent in a function definition. */
export function zodToSchemaString(schema: ZodTypeAny, side: Side = 'input'): string {
  return JSON.stringify(zodToFlattenedSchema(schema, side));
}
