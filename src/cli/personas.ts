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
import { parsePayload, PayloadError, PERSONA_NAME_RE, PERSONA_VAR_PREFIX, resolvePlaceholders, type SyncPayload } from "../persona/sync/payload";

const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : undefined);
// The gateway only resolves ${PERSONA_UPPER_CASE_NAME}; persona names are lower-case with hyphens.
const varFor = (name: string) => `${PERSONA_VAR_PREFIX}${name.replace(/-/g, "_").toUpperCase()}_XOXP`;

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
  const payload = parsePayload({ ...meta, personas });
  // Run the gateway's placeholder validation (with every name satisfied) so a
  // malformed ${...} fails the pull request instead of 422ing at deploy.
  const anyEnv = new Proxy({}, { get: () => "x" }) as Record<string, string>;
  for (const p of payload.personas) resolvePlaceholders(p, anyEnv);
  return payload;
}

const upper = (s: string) => s.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
// Only a placeholder the gateway will resolve is kept as is; any other value,
// including a ${NAME} outside PERSONA_*, is replaced by a generated PERSONA_ name.
const PLACEHOLDER_ONLY = /^\$\{PERSONA_[A-Z0-9_]+\}$/;

const SECRET_ARG_RE = /(key=|token=|secret=|password=|passwd=|bearer )/i;
const SECRET_FLAG_RE = /^--?[a-z0-9_-]*(key|token|secret|password)$/i;

/** Claim a generated variable name; two different origins must never share one. */
function claim(reg: Map<string, string>, name: string, origin: string): void {
  const prior = reg.get(name);
  if (prior !== undefined && prior !== origin) {
    throw new PayloadError(`variable name collision on \${${name}}: ${prior} and ${origin} would share one variable`);
  }
  reg.set(name, origin);
}

/** Rewrite literal credentials in MCP config to placeholders; never keeps the original value. */
function scrubMcp(persona: string, file: string, raw: string, reg: Map<string, string>, argsServers: string[]): string {
  let cfg: any;
  try {
    cfg = JSON.parse(raw);
  } catch {
    // Deliberately no parser message: it can quote file content.
    throw new PayloadError(`persona '${persona}': ${file} is not valid JSON`);
  }
  const servers = cfg && typeof cfg === "object" ? cfg.mcpServers : undefined;
  if (servers && typeof servers === "object") {
    for (const [server, def] of Object.entries<any>(servers)) {
      if (!def || typeof def !== "object") continue;
      if (typeof def.url === "string") {
        let bad = false;
        try {
          const u = new URL(def.url);
          bad = !!(u.username || u.password || u.search || u.hash);
        } catch {
          bad = /[@?#]/.test(def.url);
        }
        if (bad) {
          throw new PayloadError(`persona '${persona}': server '${server}' url carries credentials (userinfo, query string or fragment) — move the secret into a header first`);
        }
      }
      if (Array.isArray(def.args)) {
        const args: unknown[] = def.args;
        const risky = args.some((a, i) =>
          typeof a === "string" && (SECRET_ARG_RE.test(a) || (SECRET_FLAG_RE.test(a) && i + 1 < args.length && !String(args[i + 1]).startsWith("-"))));
        if (risky) {
          throw new PayloadError(`persona '${persona}': server '${server}' has args that look like a credential — move it into env as a placeholder first`);
        }
        if (args.length) argsServers.push(`${persona}/${server}`);
      }
      for (const field of ["headers", "env"]) {
        const m = def[field];
        if (!m || typeof m !== "object") continue;
        for (const [k, v] of Object.entries(m)) {
          if (typeof v !== "string") {
            throw new PayloadError(`persona '${persona}': server '${server}' ${field}.${k} is not a string — cannot be exported safely`);
          }
          if (PLACEHOLDER_ONLY.test(v)) continue;
          const name = `${PERSONA_VAR_PREFIX}${upper(persona)}_${upper(server)}_${upper(k)}`;
          claim(reg, name, `${persona}/${server}/${k}`);
          m[k] = `\${${name}}`;
        }
      }
    }
  }
  return JSON.stringify(cfg, null, 2) + "\n";
}

export function exportHome(home: string, out: string): { variables: string[] } {
  const reg = new Map<string, string>();
  const argsServers: string[] = [];
  const write = (name: string, files: Record<string, string>) => {
    const d = join(out, "personas", name);
    mkdirSync(d, { recursive: true });
    for (const [f, body] of Object.entries(files)) writeFileSync(join(d, f), body);
  };
  const defaultSoul = read(join(home, "SOUL.md"));
  const defaultMcp = read(join(home, ".mcp.json"));
  if (defaultSoul !== undefined) {
    write("default", { "SOUL.md": defaultSoul, ...(defaultMcp ? { "mcp.json": scrubMcp("default", ".mcp.json", defaultMcp, reg, argsServers) } : {}) });
  }
  const root = join(home, "personas");
  if (existsSync(root)) {
    for (const name of readdirSync(root).sort()) {
      const d = join(root, name);
      if (!statSync(d).isDirectory()) continue;
      if (!PERSONA_NAME_RE.test(name)) throw new PayloadError(`directory '${name}' is not a valid persona name`);
      let cfg: { slackUserId?: string; userToken?: string };
      try {
        cfg = (JSON.parse(read(join(d, "config.json")) ?? "{}") ?? null) as typeof cfg;
        if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("not an object");
      } catch {
        throw new PayloadError(`persona '${name}': config.json is malformed`);
      }
      const lines = [`slackUserId: ${JSON.stringify(cfg.slackUserId ?? "")}`];
      if (cfg.userToken) {
        const v = varFor(name);
        claim(reg, v, `${name}/userToken`);
        lines.push(`userToken: "\${${v}}"`); // the value never leaves $SLAUDE_HOME
      }
      const mcp = read(join(d, "mcp.json"));
      write(name, {
        "persona.yaml": lines.join("\n") + "\n",
        "SOUL.md": read(join(d, "SOUL.md")) ?? "",
        ...(mcp ? { "mcp.json": scrubMcp(name, "mcp.json", mcp, reg, argsServers) } : {}),
      });
    }
  }
  if (argsServers.length) {
    console.error(`[personas] review stdio args before committing (names only): ${argsServers.join(", ")}`);
  }
  return { variables: [...reg.keys()] };
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  const valued = new Set(["--revision", "--committed-at", "--out"]);
  const flags = new Map<string, string>();
  const rest: string[] = []; // positionals, flags removed
  for (let i = 0; i < args.length; i++) {
    if (valued.has(args[i]!)) flags.set(args[i]!, args[++i] ?? "");
    else if (args[i]!.startsWith("--")) flags.set(args[i]!, "");
    else rest.push(args[i]!);
  }
  const flag = (n: string) => flags.get(n);
  try {
    if (cmd === "render" && rest[0]) {
      const p = renderDir(rest[0], {
        revision: flag("--revision") ?? process.env.GITHUB_SHA ?? "local",
        committedAt: flag("--committed-at") ?? new Date().toISOString(),
      });
      if (!flags.has("--check")) console.log(JSON.stringify(p, null, 2));
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
