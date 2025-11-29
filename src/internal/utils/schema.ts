import { z, ZodTypeAny } from 'zod';

/**
 * Convert a Zod type to a Go-like type string.
 * This matches the Go SDK's type naming convention.
 */
function zodTypeToGoType(zodType: ZodTypeAny): string {
  const typeName = zodType._def.typeName;

  switch (typeName) {
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
      // Check if it's an integer
      const checks = (zodType._def as { checks?: { kind: string }[] }).checks || [];
      const isInt = checks.some((c) => c.kind === 'int');
      return isInt ? 'int' : 'float64';
    case 'ZodBigInt':
      return 'int64';
    case 'ZodBoolean':
      return 'bool';
    case 'ZodDate':
      return 'time.Time';
    case 'ZodNull':
    case 'ZodUndefined':
    case 'ZodVoid':
      return 'nil';
    case 'ZodAny':
    case 'ZodUnknown':
      return 'interface{}';
    case 'ZodNever':
      return 'never';
    case 'ZodLiteral':
      const literalValue = (zodType._def as { value: unknown }).value;
      return typeof literalValue;
    case 'ZodEnum':
    case 'ZodNativeEnum':
      return 'string'; // Enums are typically represented as strings
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      return 'interface{}'; // Unions become interface{}
    case 'ZodIntersection':
      return 'interface{}';
    case 'ZodTuple':
      return '[]interface{}';
    case 'ZodRecord':
      return 'map[string]interface{}';
    case 'ZodFunction':
      return 'func';
    case 'ZodLazy':
      const innerType = (zodType._def as { getter: () => ZodTypeAny }).getter();
      return zodTypeToGoType(innerType);
    case 'ZodEffects':
      // Effects wrap another schema (for transforms, refinements, etc.)
      const innerSchema = (zodType._def as { schema: ZodTypeAny }).schema;
      return zodTypeToGoType(innerSchema);
    case 'ZodOptional':
    case 'ZodNullable':
      // For optional/nullable, get the inner type
      const innerOpt = (zodType._def as { innerType: ZodTypeAny }).innerType;
      return zodTypeToGoType(innerOpt);
    case 'ZodDefault':
      const innerDefault = (zodType._def as { innerType: ZodTypeAny }).innerType;
      return zodTypeToGoType(innerDefault);
    case 'ZodPromise':
      const promiseInner = (zodType._def as { type: ZodTypeAny }).type;
      return zodTypeToGoType(promiseInner);
    case 'ZodBranded':
      const brandedInner = (zodType._def as { type: ZodTypeAny }).type;
      return zodTypeToGoType(brandedInner);
    case 'ZodPipeline':
      const pipelineOut = (zodType._def as { out: ZodTypeAny }).out;
      return zodTypeToGoType(pipelineOut);
    case 'ZodReadonly':
      const readonlyInner = (zodType._def as { innerType: ZodTypeAny }).innerType;
      return zodTypeToGoType(readonlyInner);
    default:
      return 'interface{}';
  }
}

/**
 * Build the flattened schema recursively.
 * This matches the Go SDK's getTypeSchema format.
 */
function buildFlattenedSchema(
  zodType: ZodTypeAny,
  path: string,
  result: Record<string, string>
): void {
  const typeName = zodType._def.typeName;

  // Handle wrapper types first
  if (
    typeName === 'ZodOptional' ||
    typeName === 'ZodNullable' ||
    typeName === 'ZodDefault' ||
    typeName === 'ZodReadonly'
  ) {
    const innerType = (zodType._def as { innerType: ZodTypeAny }).innerType;
    buildFlattenedSchema(innerType, path, result);
    return;
  }

  if (typeName === 'ZodEffects') {
    const innerSchema = (zodType._def as { schema: ZodTypeAny }).schema;
    buildFlattenedSchema(innerSchema, path, result);
    return;
  }

  if (typeName === 'ZodLazy') {
    const innerType = (zodType._def as { getter: () => ZodTypeAny }).getter();
    buildFlattenedSchema(innerType, path, result);
    return;
  }

  if (typeName === 'ZodBranded') {
    const innerType = (zodType._def as { type: ZodTypeAny }).type;
    buildFlattenedSchema(innerType, path, result);
    return;
  }

  // Handle objects (structs)
  if (typeName === 'ZodObject') {
    const shape = (zodType._def as { shape: () => Record<string, ZodTypeAny> }).shape();
    for (const [fieldName, fieldType] of Object.entries(shape)) {
      const fieldPath = path ? `${path}.${fieldName}` : fieldName;
      buildFlattenedSchema(fieldType, fieldPath, result);
    }
    return;
  }

  // Handle arrays
  if (typeName === 'ZodArray') {
    const arrayPath = path + '[]';
    const elementType = (zodType._def as { type: ZodTypeAny }).type;
    const elemTypeName = elementType._def.typeName;

    // If array contains objects, recurse into the object fields
    if (
      elemTypeName === 'ZodObject' ||
      elemTypeName === 'ZodOptional' ||
      elemTypeName === 'ZodNullable'
    ) {
      buildFlattenedSchema(elementType, arrayPath, result);
    } else {
      // For primitive arrays, just add the type
      result[arrayPath] = zodTypeToGoType(elementType);
    }
    return;
  }

  // Handle maps/records
  if (typeName === 'ZodRecord') {
    const valueType = (zodType._def as { valueType: ZodTypeAny }).valueType;
    result[path + '[map]'] = `map[string]${zodTypeToGoType(valueType)}`;
    return;
  }

  // Handle maps with explicit key type
  if (typeName === 'ZodMap') {
    const keyType = (zodType._def as { keyType: ZodTypeAny }).keyType;
    const valueType = (zodType._def as { valueType: ZodTypeAny }).valueType;
    result[path + '[map]'] = `map[${zodTypeToGoType(keyType)}]${zodTypeToGoType(valueType)}`;
    return;
  }

  // Handle tuples as arrays
  if (typeName === 'ZodTuple') {
    result[path + '[]'] = 'interface{}';
    return;
  }

  // For all other types (primitives), add directly
  if (path) {
    result[path] = zodTypeToGoType(zodType);
  } else {
    result['type'] = zodTypeToGoType(zodType);
  }
}

/**
 * Convert a Zod schema to the Go SDK's flattened type schema format.
 * 
 * This produces output like:
 * {
 *   "spreadsheet_id": "string",
 *   "title": "string",
 *   "sheet_contents[].sheet_name": "string",
 *   "sheet_contents[].row_count": "int",
 *   "sheet_contents[].col_count": "int"
 * }
 * 
 * Which matches the Go SDK's getTypeSchema format.
 */
export function zodToFlattenedSchema(schema: ZodTypeAny): Record<string, string> {
  const result: Record<string, string> = {};
  buildFlattenedSchema(schema, '', result);
  return result;
}

/**
 * Convert a Zod schema to a JSON string in the Go SDK's format.
 */
export function zodToSchemaString(schema: ZodTypeAny): string {
  return JSON.stringify(zodToFlattenedSchema(schema));
}

