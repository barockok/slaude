/**
 * Personas as code, from the command line.
 *
 *   personas render <dir> [--revision <sha>] [--committed-at <iso>] [--check]
 *       Repository → sync payload, validated exactly as the gateway validates
 *       it, so a malformed file fails the pull request rather than the deploy.
 *   personas export [--out <dir>]
 *       $SLAUDE_HOME → repository layout. Every token is replaced by a ${VAR}
 *       placeholder and the variables are listed, so seeding a repository never
 *       puts a secret in git.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/home";
import { parsePayload, PayloadError, PERSONA_NAME_RE, type SyncPayload } from "../persona/sync/payload";

const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : undefined);
// The gateway only resolves ${UPPER_CASE_NAME}; persona names are lower-case with hyphens.
const varFor = (name: string) => `${name.replace(/-/g, "_").toUpperCase()}_XOXP`;

export function renderDir(dir: string, meta: { revision: string; committedAt: string }): SyncPayload {
  const root = join(dir, "personas");
  if (!existsSync(root)) throw new PayloadError(`no personas/ directory in ${dir}`);
  const personas = [];
  for (const name of readdirSync(root).sort()) {
    if (!statSync(join(root, name)).isDirectory()) continue;
    if (!PERSONA_NAME_RE.test(name)) throw new PayloadError(`directory '${name}' is not a valid persona name`);
    const yaml = read(join(root, name, "persona.yaml"));
    let cfg: { slackUserId?: string; userToken?: string; model?: string };
    try {
      cfg = ((yaml ? Bun.YAML.parse(yaml) : {}) ?? {}) as typeof cfg;
    } catch (e) {
      throw new PayloadError(`persona '${name}': persona.yaml is not valid YAML (${(e as Error).message})`);
    }
    const soul = read(join(root, name, "SOUL.md"));
    if (soul === undefined) throw new PayloadError(`persona '${name}' has no SOUL.md`);
    const mcpRaw = read(join(root, name, "mcp.json"));
    let mcp: unknown;
    if (mcpRaw) {
      try {
        mcp = JSON.parse(mcpRaw);
      } catch (e) {
        throw new PayloadError(`persona '${name}': mcp.json is not valid JSON (${(e as Error).message})`);
      }
    }
    personas.push({
      name,
      soul,
      // String() so a YAML scalar like an unquoted number reaches the schema as a string, not a type error.
      ...(cfg.slackUserId ? { slackUserId: String(cfg.slackUserId) } : {}),
      ...(cfg.userToken ? { userToken: String(cfg.userToken) } : {}),
      ...(cfg.model ? { model: String(cfg.model) } : {}),
      ...(mcp !== undefined ? { mcp } : {}),
    });
  }
  // The gateway refuses a non-empty sync without a default persona; catch it on the pull request.
  if (personas.length > 0 && !personas.some((p) => p.name === "default")) {
    throw new PayloadError("personas/ has personas but no default/ — a non-empty sync must include a persona named 'default'");
  }
  return parsePayload({ ...meta, personas });
}

export function exportHome(home: string, out: string): { variables: string[] } {
  const variables: string[] = [];
  const write = (name: string, files: Record<string, string>) => {
    const d = join(out, "personas", name);
    mkdirSync(d, { recursive: true });
    for (const [f, body] of Object.entries(files)) writeFileSync(join(d, f), body);
  };
  const defaultSoul = read(join(home, "SOUL.md"));
  const defaultMcp = read(join(home, ".mcp.json"));
  if (defaultSoul !== undefined) {
    write("default", { "SOUL.md": defaultSoul, ...(defaultMcp ? { "mcp.json": defaultMcp } : {}) });
  }
  const root = join(home, "personas");
  if (existsSync(root)) {
    for (const name of readdirSync(root).sort()) {
      const d = join(root, name);
      if (!statSync(d).isDirectory()) continue;
      const cfg = JSON.parse(read(join(d, "config.json")) ?? "{}") as { slackUserId?: string; userToken?: string };
      const lines = [`slackUserId: ${JSON.stringify(cfg.slackUserId ?? "")}`];
      if (cfg.userToken) {
        const v = varFor(name);
        variables.push(v);
        lines.push(`userToken: "\${${v}}"`); // the value never leaves $SLAUDE_HOME
      }
      const mcp = read(join(d, "mcp.json"));
      write(name, {
        "persona.yaml": lines.join("\n") + "\n",
        "SOUL.md": read(join(d, "SOUL.md")) ?? "",
        ...(mcp ? { "mcp.json": mcp } : {}),
      });
    }
  }
  return { variables };
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (n: string) => {
    const i = rest.indexOf(n);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  try {
    if (cmd === "render" && rest[0]) {
      const p = renderDir(rest[0], {
        revision: flag("--revision") ?? process.env.GITHUB_SHA ?? "local",
        committedAt: flag("--committed-at") ?? new Date().toISOString(),
      });
      if (!rest.includes("--check")) console.log(JSON.stringify(p, null, 2));
    } else if (cmd === "export") {
      const out = flag("--out") ?? "./persona-repo";
      const { variables } = exportHome(paths.home, out);
      console.error(`[personas] exported to ${out}`);
      if (variables.length) console.error(`[personas] set these in the gateway environment: ${variables.join(", ")}`);
    } else {
      console.error("usage: personas render <dir> [--revision <sha>] [--committed-at <iso>] [--check] | personas export [--out <dir>]");
      process.exit(2);
    }
  } catch (e) {
    console.error(`[personas] ${(e as Error).message}`);
    process.exit(1);
  }
}
