/**
 * Extraction half of scripts/vendor-slack-schemas.ts, kept separate so it is unit-testable
 * without the CLI. Per method it keeps the parameter names, the required ones and the
 * top-level response property names. Dependency-free.
 */
type Json = Record<string, any>;

export interface MethodSchema {
  params: string[];
  required: string[];
  response: string[];
  /** The spec does not describe the response, so response properties are not judged. */
  responseUnjudged?: boolean;
}

function resolveRef(spec: Json, ref: string): Json {
  let node: any = spec;
  for (const part of ref.replace(/^#\//, "").split("/")) node = node?.[part];
  return node ?? {};
}

/** Union of the top-level property names of a schema, following $ref, allOf, oneOf and anyOf. */
function propertyNames(spec: Json, schema: Json | undefined, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  if (!schema) return out;
  if (typeof schema.$ref === "string") {
    if (seen.has(schema.$ref)) return out;
    seen.add(schema.$ref);
    return propertyNames(spec, resolveRef(spec, schema.$ref), seen);
  }
  for (const k of Object.keys(schema.properties ?? {})) out.add(k);
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    for (const branch of schema[key] ?? []) for (const k of propertyNames(spec, branch, seen)) out.add(k);
  }
  return out;
}

/** The spec's own marker for a response it does not describe (e.g. search.messages: only `ok` is listed). */
const UNDESCRIBED_RESPONSE = /verbose schema is not available/i;

/** Flatten an operation's parameters to { name, required }: follows $ref and expands an `in: body` schema into its properties. */
function paramsOf(spec: Json, op: Json): Array<{ name: string; required: boolean }> {
  const out: Array<{ name: string; required: boolean }> = [];
  for (const raw of op.parameters ?? []) {
    const p: Json = typeof raw.$ref === "string" ? resolveRef(spec, raw.$ref) : raw;
    if (p.in === "body") {
      const body: Json = typeof p.schema?.$ref === "string" ? resolveRef(spec, p.schema.$ref) : (p.schema ?? {});
      for (const name of propertyNames(spec, body)) out.push({ name, required: (body.required ?? []).includes(name) });
    } else if (typeof p.name === "string" && p.name !== "token") {
      out.push({ name: p.name, required: p.required === true });
    }
  }
  return out;
}

export function extractMethods(spec: Json, methods: readonly string[]): { schemas: Record<string, MethodSchema>; missing: string[] } {
  const schemas: Record<string, MethodSchema> = {};
  const missing: string[] = [];
  for (const method of methods) {
    const op = spec.paths?.[`/${method}`]?.post ?? spec.paths?.[`/${method}`]?.get;
    if (!op) {
      missing.push(method);
      continue;
    }
    const params = paramsOf(spec, op);
    const resp = op.responses?.["200"]?.schema;
    const described = !UNDESCRIBED_RESPONSE.test(String(resp?.description ?? ""));
    schemas[method] = {
      params: params.map((p) => p.name).sort(),
      required: params.filter((p) => p.required).map((p) => p.name).sort(),
      response: [...propertyNames(spec, resp)].sort(),
      ...(described ? {} : { responseUnjudged: true }),
    };
  }
  return { schemas, missing };
}
