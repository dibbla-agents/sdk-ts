/**
 * Structural matcher for scenario expectations.
 *
 * Expectations are plain JSON with a few string and object tokens:
 *
 *   "$any"            anything, including an absent key
 *   "$nonempty"       a non-empty string
 *   "$capture:NAME"   a non-empty string, remembered as ${NAME}
 *   "$prefix:TEXT"    a string starting with TEXT
 *   "$regex:RE"       a string matching RE
 *   {"$json": X}      a string that parses as JSON matching X
 *   {"$unordered": [...]}  an array with the same elements in any order
 *
 * Objects are matched strictly: the actual object must have exactly the
 * expected keys, except keys whose expectation is "$any". Strictness is the
 * point — an SDK that sends an extra field, or omits one Go omits, is exactly
 * the drift the suite exists to catch.
 */

export type Vars = Record<string, string>;

export interface MatchResult {
  ok: boolean;
  /** Where and why the first mismatch happened. */
  error?: string;
  /** Values captured by "$capture:NAME", committed only on success. */
  captures: Vars;
}

const ok = (captures: Vars = {}): MatchResult => ({ ok: true, captures });
const fail = (path: string, error: string): MatchResult => ({ ok: false, error: `${path || '<root>'}: ${error}`, captures: {} });

function describe(value: unknown): string {
  const s = JSON.stringify(value);
  if (s === undefined) return String(value);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Replace ${name} references in every string of a template. */
export function substitute<T>(template: T, vars: Vars): T {
  if (typeof template === 'string') {
    return template.replace(/\$\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
      if (!(name in vars)) {
        throw new Error(`template references unknown variable \${${name}}`);
      }
      return vars[name];
    }) as unknown as T;
  }
  if (Array.isArray(template)) {
    return template.map((v) => substitute(v, vars)) as unknown as T;
  }
  if (isPlainObject(template)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template)) {
      out[k] = substitute(v, vars);
    }
    return out as T;
  }
  return template;
}

export function match(expected: unknown, actual: unknown, vars: Vars, path = ''): MatchResult {
  if (typeof expected === 'string') {
    return matchString(expected, actual, vars, path);
  }

  if (isPlainObject(expected)) {
    if ('$json' in expected) {
      if (typeof actual !== 'string') {
        return fail(path, `expected a JSON-encoded string, got ${describe(actual)}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(actual);
      } catch (err) {
        return fail(path, `expected a JSON-encoded string, got unparseable ${describe(actual)}`);
      }
      return match(expected.$json, parsed, vars, `${path}<json>`);
    }
    if ('$unordered' in expected) {
      return matchUnordered(expected.$unordered as unknown[], actual, vars, path);
    }
    if (!isPlainObject(actual)) {
      return fail(path, `expected an object, got ${describe(actual)}`);
    }
    const captures: Vars = {};
    for (const [key, exp] of Object.entries(expected)) {
      const childPath = path ? `${path}.${key}` : key;
      if (!(key in actual)) {
        if (exp === '$any') continue;
        return fail(childPath, `missing (expected ${describe(exp)})`);
      }
      const r = match(exp, actual[key], { ...vars, ...captures }, childPath);
      if (!r.ok) return r;
      Object.assign(captures, r.captures);
    }
    for (const key of Object.keys(actual)) {
      if (!(key in expected)) {
        const childPath = path ? `${path}.${key}` : key;
        return fail(childPath, `unexpected key with value ${describe(actual[key])}`);
      }
    }
    return ok(captures);
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return fail(path, `expected an array, got ${describe(actual)}`);
    }
    if (actual.length !== expected.length) {
      return fail(path, `expected ${expected.length} elements, got ${actual.length}: ${describe(actual)}`);
    }
    const captures: Vars = {};
    for (let i = 0; i < expected.length; i++) {
      const r = match(expected[i], actual[i], { ...vars, ...captures }, `${path}[${i}]`);
      if (!r.ok) return r;
      Object.assign(captures, r.captures);
    }
    return ok(captures);
  }

  // number, boolean, null
  if (expected !== actual) {
    return fail(path, `expected ${describe(expected)}, got ${describe(actual)}`);
  }
  return ok();
}

function matchString(expected: string, actual: unknown, vars: Vars, path: string): MatchResult {
  if (expected === '$any') return ok();
  if (expected === '$nonempty') {
    return typeof actual === 'string' && actual !== ''
      ? ok()
      : fail(path, `expected a non-empty string, got ${describe(actual)}`);
  }
  if (expected.startsWith('$capture:')) {
    if (typeof actual !== 'string' || actual === '') {
      return fail(path, `expected a non-empty string to capture, got ${describe(actual)}`);
    }
    return ok({ [expected.slice('$capture:'.length)]: actual });
  }
  if (expected.startsWith('$prefix:')) {
    const prefix = expected.slice('$prefix:'.length);
    return typeof actual === 'string' && actual.startsWith(prefix)
      ? ok()
      : fail(path, `expected a string starting with ${describe(prefix)}, got ${describe(actual)}`);
  }
  if (expected.startsWith('$regex:')) {
    const re = new RegExp(expected.slice('$regex:'.length));
    return typeof actual === 'string' && re.test(actual)
      ? ok()
      : fail(path, `expected a string matching /${re.source}/, got ${describe(actual)}`);
  }
  if (expected !== actual) {
    return fail(path, `expected ${describe(expected)}, got ${describe(actual)}`);
  }
  return ok();
}

function matchUnordered(expected: unknown[], actual: unknown, vars: Vars, path: string): MatchResult {
  if (!Array.isArray(actual)) {
    return fail(path, `expected an array, got ${describe(actual)}`);
  }
  if (actual.length !== expected.length) {
    return fail(path, `expected ${expected.length} elements in any order, got ${actual.length}: ${describe(actual)}`);
  }
  const used = new Array<boolean>(actual.length).fill(false);
  const captures: Vars = {};
  for (let i = 0; i < expected.length; i++) {
    let found = false;
    let closest: MatchResult | undefined;
    for (let j = 0; j < actual.length; j++) {
      if (used[j]) continue;
      const r = match(expected[i], actual[j], { ...vars, ...captures }, `${path}[?${j}]`);
      if (r.ok) {
        used[j] = true;
        Object.assign(captures, r.captures);
        found = true;
        break;
      }
      closest ??= r;
    }
    if (!found) {
      return fail(
        path,
        `no element matches expected ${describe(expected[i])}` + (closest ? ` (first mismatch: ${closest.error})` : ''),
      );
    }
  }
  return ok(captures);
}
