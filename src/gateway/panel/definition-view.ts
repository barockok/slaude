/**
 * The console's "Definition" view: an agent as one read-only document, the
 * effective state written out in agent.yaml's shape, whichever way it was
 * defined. Built from references and presence only: a secret value never
 * enters the document. MCP server config is reduced to names, types and hosts;
 * credentials and tokens read as placeholders.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { paths } from "../../config/home";
import { agentDocument, proseOnlySoul } from "../../persona/agent-def";
import { getPersonaRegistry, managedPersonaDefinition, type PersonaRegistry } from "../../persona/registry";
import { personaSoulText } from "../../persona/soul-source";
import { personaMandateText } from "../../soul/persona-mandates";
import { soulDataFor } from "../../soul/per-persona";
import { redactSecrets } from "../core/status-text";
import { providerView } from "./persona-view";
import type { AgentDefinitionView } from "./api-types";

const REDACTED = "<redacted>";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Server names, types and hosts; every value that could hold a credential is a placeholder. */
export function redactedMcp(mcp: unknown): unknown {
  if (!isObj(mcp)) return null;
  const servers = isObj(mcp.mcpServers) ? mcp.mcpServers : {};
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(servers)) {
    const cfg = isObj(raw) ? raw : {};
    let host: string | null = null;
    if (typeof cfg.url === "string") {
      try {
        const u = new URL(cfg.url);
        host = `${u.protocol}//${u.host}`;
      } catch {
        host = REDACTED;
      }
    }
    const keys = (m: unknown) => (isObj(m) ? Object.fromEntries(Object.keys(m).map((k) => [k, REDACTED])) : undefined);
    out[name] = {
      ...(typeof cfg.type === "string" ? { type: cfg.type } : {}),
      ...(host ? { url: host } : {}),
      ...(cfg.command !== undefined ? { command: REDACTED } : {}),
      ...(cfg.args !== undefined ? { args: REDACTED } : {}),
      ...(keys(cfg.headers) ? { headers: keys(cfg.headers) } : {}),
      ...(keys(cfg.env) ? { env: keys(cfg.env) } : {}),
    };
  }
  return {
    mcpServers: out,
    ...(Array.isArray(mcp.privateServices) ? { privateServices: mcp.privateServices.filter((n) => typeof n === "string") } : {}),
  };
}

function readFileMcp(name: string): unknown {
  const path = name === "default" ? join(paths.home, ".mcp.json") : join(paths.personas, name, "mcp.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Set fields only: a reference, a URL reduced to its host and path, or "stored". */
function providerRefs(p: Parameters<typeof providerView>[0]): Record<string, string> | null {
  const view = providerView(p);
  const out = Object.fromEntries(Object.entries(view).filter(([, v]) => v && v !== "none")) as Record<string, string>;
  return Object.keys(out).length ? out : null;
}

/** `canSeeValues`: the viewer may read redaction patterns (a pattern can name
 *  what it hides, a project or a customer); anyone else gets a count. */
export function agentDefinitionView(name: string, r: PersonaRegistry = getPersonaRegistry(), opts: { canSeeValues?: boolean } = {}): AgentDefinitionView {
  const persona = name === "default" ? null : r.lookupByName(name);
  const definition = managedPersonaDefinition(name === "default" ? undefined : name, r);
  const source: AgentDefinitionView["source"] = definition ? "agent.yaml" : "soul";
  try {
    const fields = r.isManaged() ? (name === "default" ? r.defaultPersona?.() ?? null : persona) : null;
    const mandates = personaMandateText(name);
    const access = soulDataFor(name);
    const cleanScope = <T extends { scope: string }>(a: T): T => ({ ...a, scope: redactSecrets(a.scope) });
    const doc = agentDocument({
      name,
      description: definition?.description ? redactSecrets(definition.description) : null,
      model: fields?.model ?? null,
      slackUserId: persona?.slackUserId ?? null,
      userToken: persona?.config.userToken ? REDACTED : null,
      provider: providerRefs(fields?.provider),
      runsOn: fields?.runsOn ?? null,
      // Free text can carry a credential by accident; the structured keys are
      // written by this module, and a text pass over the whole document would
      // mangle YAML keys such as `userToken:`.
      soul: redactSecrets(proseOnlySoul(personaSoulText(name === "default" ? undefined : name))),
      mandate: { global: redactSecrets(mandates.global), scoped: mandates.subMandates.map((m) => ({ ...m, text: redactSecrets(m.text) })) },
      access: {
        ...access,
        approvers: access.approvers.map(cleanScope),
        channelOverrides: access.channelOverrides.map((c) => ({ ...c, approvers: c.approvers.map(cleanScope) })),
      },
      mcp: redactedMcp(fields ? fields.mcp : readFileMcp(name)),
      skills: definition?.skills ?? null,
      guardrails: definition?.guardrails ?? null,
      kbSources: fields?.kbSources ?? null,
      background: fields?.background ?? null,
    });
    const shownAccess = doc.access as { redact?: unknown } | undefined;
    if (!opts.canSeeValues && Array.isArray(shownAccess?.redact)) {
      const n = shownAccess.redact.length;
      shownAccess.redact = `${n} ${n === 1 ? "pattern" : "patterns"}`;
    }
    return { source, yaml: stringify(doc, { lineWidth: 0 }) };
  } catch (e) {
    console.error(`[panel] definition view failed for an agent: ${e instanceof Error ? e.name : typeof e}`);
    return { source, yaml: "# The definition could not be read.\n" };
  }
}
