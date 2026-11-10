/**
 * Writes schemas/agent.schema.json from the Zod schema in
 * src/persona/agent-schema.ts: `bun run schema:agent`. A test regenerates it in
 * memory and fails when the committed file differs, so the two cannot drift.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AGENT_SCHEMA_URL, AgentSchema } from "../src/persona/agent-schema";

export { AGENT_SCHEMA_URL };
export const AGENT_SCHEMA_FILE = join(import.meta.dir, "..", "schemas", "agent.schema.json");

/** zod-to-json-schema repeats a field's description inside its `anyOf` members; keep the outer one. */
function dedupeDescriptions(node: unknown, parent?: string): void {
  if (Array.isArray(node)) return node.forEach((n) => dedupeDescriptions(n, parent));
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (parent !== undefined && o.description === parent) delete o.description;
  const mine = typeof o.description === "string" ? o.description : undefined;
  for (const v of Object.values(o)) dedupeDescriptions(v, Array.isArray(o.anyOf) && v === o.anyOf ? mine : undefined);
}

export function buildAgentJsonSchema(): Record<string, unknown> {
  const generated = zodToJsonSchema(AgentSchema, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;
  const { $schema, ...rest } = generated;
  const schema = { $schema, $id: AGENT_SCHEMA_URL, title: "slaude agent.yaml", ...rest } as Record<string, unknown>;
  // A repeated skill or guardrail is refused by the validator; say so in the editor too.
  const props = schema.properties as Record<string, Record<string, unknown>>;
  for (const key of ["skills", "guardrails"]) {
    const p = props[key]!;
    const list = (Array.isArray(p.anyOf) ? p.anyOf.find((x: Record<string, unknown>) => x.type === "array") : p) as Record<string, unknown>;
    list.uniqueItems = true;
  }
  dedupeDescriptions(schema);
  return schema;
}

export function agentSchemaText(): string {
  return JSON.stringify(buildAgentJsonSchema(), null, 2) + "\n";
}

if (import.meta.main) {
  writeFileSync(AGENT_SCHEMA_FILE, agentSchemaText());
  console.log(`wrote ${AGENT_SCHEMA_FILE}`);
}
