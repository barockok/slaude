/**
 * Derive e2e/fake-slack/schemas/methods.json from the archived Slack Web API OpenAPI 2.0 spec
 * (slackapi/slack-api-specs, MIT). Keeps only what the fake's schema guard judges: per method the
 * parameter names, the required ones and the top-level response property names.
 *
 *   bun scripts/vendor-slack-schemas.ts <spec path | URL> --commit <sha> [--license MIT] [--out <file>]
 *
 * Methods the spec does not describe are left out (the guard does not judge them). Dependency-free.
 */
import { writeFileSync } from "node:fs";

type Json = Record<string, any>;

export interface MethodSchema {
  params: string[];
  required: string[];
  response: string[];
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

export function extractMethods(spec: Json, methods: readonly string[]): { schemas: Record<string, MethodSchema>; missing: string[] } {
  const schemas: Record<string, MethodSchema> = {};
  const missing: string[] = [];
  for (const method of methods) {
    const op = spec.paths?.[`/${method}`]?.post ?? spec.paths?.[`/${method}`]?.get;
    if (!op) {
      missing.push(method);
      continue;
    }
    const params = (op.parameters ?? []).filter((p: Json) => p.name !== "token");
    schemas[method] = {
      params: params.map((p: Json) => p.name as string).sort(),
      required: params.filter((p: Json) => p.required === true).map((p: Json) => p.name as string).sort(),
      response: [...propertyNames(spec, op.responses?.["200"]?.schema)].sort(),
    };
  }
  return { schemas, missing };
}

async function load(src: string): Promise<Json> {
  if (/^https?:\/\//.test(src)) return (await (await fetch(src)).json()) as Json;
  return (await Bun.file(src).json()) as Json;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback?: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const src = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  const commit = flag("commit");
  if (!src || !commit) {
    console.error("usage: bun scripts/vendor-slack-schemas.ts <spec path | URL> --commit <sha> [--license MIT] [--out <file>]");
    process.exit(2);
  }
  const { KNOWN_METHODS } = await import("../e2e/fake-slack/core/web-api");
  const { schemas, missing } = extractMethods(await load(src), KNOWN_METHODS);
  const out = flag("out", "e2e/fake-slack/schemas/methods.json")!;
  const doc = { source: "slackapi/slack-api-specs", commit, license: flag("license", "MIT"), methods: schemas };
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${out}: ${Object.keys(schemas).length} methods`);
  if (missing.length) console.log(`not in the spec (left un-schema'd): ${missing.join(", ")}`);
}
