/**
 * Personas as code, from the command line.
 *
 *   personas render <dir> [--revision <sha>] [--committed-at <iso>] [--check]
 *       Repository → sync payload, validated exactly as the gateway validates
 *       it, so a malformed file fails the pull request rather than the deploy.
 *   personas export [--out <dir>]
 *       $SLAUDE_HOME → repository layout. Every userToken, header and env value
 *       is replaced by a ${PERSONA_*} placeholder and the variables are listed.
 *       Anything export cannot make safe — an unknown key, a non-object
 *       headers/env, a non-list args, a token-shaped url path, command or arg —
 *       fails the export instead of being copied, so seeding a repository
 *       refuses rather than puts a secret in git.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/home";
import { parsePayload, PayloadError, PERSONA_NAME_RE, PERSONA_VAR_PREFIX, resolvePlaceholders, safeKey, capPaths, payloadVersionFor, providerWarnings, type SyncPayload } from "../persona/sync/payload";

const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : undefined);
// The gateway only resolves ${PERSONA_UPPER_CASE_NAME}; persona names are lower-case with hyphens.
const varFor = (name: string) => `${PERSONA_VAR_PREFIX}${name.replace(/-/g, "_").toUpperCase()}_XOXP`;

const YAML_KEYS = new Set(["slackUserId", "userToken", "model", "provider"]);

/** `onUnknown` receives `persona.<name>.<key>` for each persona.yaml key the payload has no field for (names only).
 *  `onWarnings` receives the gateway's provider/model sync warnings (WS-A §4). */
export function renderDir(
  dir: string,
  meta: { revision: string; committedAt: string },
  onUnknown?: (paths: string[]) => void,
  onWarnings?: (warnings: string[]) => void,
): SyncPayload {
  const unknown: string[] = [];
  const root = join(dir, "personas");
  if (!existsSync(root)) throw new PayloadError(`no personas/ directory in ${dir}`);
  const personas = [];
  for (const name of readdirSync(root).sort()) {
    if (!statSync(join(root, name)).isDirectory()) continue;
    if (!PERSONA_NAME_RE.test(name)) throw new PayloadError(`directory '${name}' is not a valid persona name`);
    const yaml = read(join(root, name, "persona.yaml"));
    let cfg: { slackUserId?: string; userToken?: string; model?: string; provider?: unknown };
    try {
      cfg = ((yaml ? Bun.YAML.parse(yaml) : {}) ?? {}) as typeof cfg;
    } catch (e) {
      throw new PayloadError(`persona '${name}': persona.yaml is not valid YAML (${(e as Error).message})`);
    }
    if (cfg && typeof cfg === "object") {
      for (const k of Object.keys(cfg)) if (!YAML_KEYS.has(k)) unknown.push(`persona.${name}.${safeKey(k)}`);
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
      // Passed as written: parsePayload validates it with the gateway's own parser.
      ...(cfg.provider !== undefined ? { provider: cfg.provider } : {}),
      ...(mcp !== undefined ? { mcp } : {}),
    });
  }
  // The gateway refuses a non-empty sync without a default persona; catch it on the pull request.
  if (personas.length > 0 && !personas.some((p) => p.name === "default")) {
    throw new PayloadError("personas/ has personas but no default/ — a non-empty sync must include a persona named 'default'");
  }
  const payload = parsePayload({ version: payloadVersionFor(personas), ...meta, personas });
  if (unknown.length) onUnknown?.(capPaths(unknown));
  const warnings = providerWarnings(payload);
  if (warnings.length) onWarnings?.(warnings);
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
/**
 * Token shapes refused anywhere export cannot placeholder: a url path, a
 * command string, an arg. Slack, GitHub, OpenAI-style, AWS access keys, a
 * Bearer prefix, a JWT, and any run of 32+ token characters (most hosted
 * secrets). False positives fail safe: the operator edits the config first.
 */
const TOKEN_SHAPES: RegExp[] = [
  /xox[a-z]-/i,
  /\bgh[opusr]_[A-Za-z0-9]/,
  /github_pat_/i,
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /AKIA[0-9A-Z]{16}/,
  /\bbearer\b/i,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./,
  /[A-Za-z0-9_-]{32,}/,
];
const looksLikeToken = (s: string) => TOKEN_SHAPES.some((re) => re.test(s));

/** The only keys export knows how to make safe. Anything else could hold a
 *  credential export has no way to recognise, so it is refused, not copied. */
const SERVER_KEYS = new Set(["type", "url", "command", "args", "headers", "env"]);
const TOP_KEYS = new Set(["mcpServers", "privateServices"]);

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
  const fail = (why: string): never => {
    throw new PayloadError(`persona '${persona}': ${file} ${why}`);
  };
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) fail("is not a JSON object");
  for (const k of Object.keys(cfg)) {
    if (!TOP_KEYS.has(k)) fail(`has unknown top-level key '${k}' — export cannot tell whether it holds a secret; remove it first`);
  }
  if (cfg.privateServices !== undefined && (!Array.isArray(cfg.privateServices) || cfg.privateServices.some((n: unknown) => typeof n !== "string"))) {
    fail("privateServices is not a list of server names");
  }
  const servers = cfg.mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    fail("mcpServers is not an object");
  }
  for (const [server, def] of Object.entries<any>(servers ?? {})) {
    const bad = (why: string): never => fail(`server '${server}' ${why}`);
    if (!def || typeof def !== "object" || Array.isArray(def)) bad("is not an object");
    for (const k of Object.keys(def)) {
      if (!SERVER_KEYS.has(k)) bad(`has unknown key '${k}' — export cannot tell whether it holds a secret; remove it or move it into headers/env first`);
    }
    if (def.type !== undefined && typeof def.type !== "string") bad("type is not a string");
    if (def.url !== undefined) {
      if (typeof def.url !== "string") bad("url is not a string");
      let path = def.url as string;
      let carries = false;
      try {
        const u = new URL(def.url);
        carries = !!(u.username || u.password || u.search || u.hash);
        path = u.pathname;
      } catch {
        carries = /[@?#]/.test(def.url);
      }
      if (carries) {
        bad("url carries credentials (userinfo, query string or fragment) — move the secret into a header first");
      }
      if (looksLikeToken(path)) bad("url path looks like it carries a token — move the secret into a header first");
    }
    if (def.command !== undefined) {
      if (typeof def.command !== "string") bad("command is not a string");
      if (SECRET_ARG_RE.test(def.command) || looksLikeToken(def.command)) {
        bad("command looks like it carries a credential — move it into env as a placeholder first");
      }
    }
    if (def.args !== undefined) {
      if (!Array.isArray(def.args)) bad("args is not a list — cannot be exported safely");
      const args: unknown[] = def.args;
      const risky = args.some((a, i) =>
        typeof a !== "string" ||
        SECRET_ARG_RE.test(a) || looksLikeToken(a) ||
        (SECRET_FLAG_RE.test(a) && i + 1 < args.length && !String(args[i + 1]).startsWith("-")));
      if (risky) {
        bad("has args that look like a credential — move it into env as a placeholder first");
      }
      if (args.length) argsServers.push(`${persona}/${server}`);
    }
    for (const field of ["headers", "env"]) {
      const m = def[field];
      if (m === undefined) continue;
      if (!m || typeof m !== "object" || Array.isArray(m)) bad(`${field} is not an object — cannot be exported safely`);
      for (const [k, v] of Object.entries(m)) {
        if (typeof v !== "string") {
          bad(`${field}.${k} is not a string — cannot be exported safely`);
        }
        if (PLACEHOLDER_ONLY.test(v as string)) continue;
        const name = `${PERSONA_VAR_PREFIX}${upper(persona)}_${upper(server)}_${upper(k)}`;
        claim(reg, name, `${persona}/${server}/${k}`);
        m[k] = `\${${name}}`;
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
      }, (paths) => {
        if (flags.has("--check")) console.error(`[personas] unknown fields (the gateway will ignore them, or refuse under SLAUDE_DEPLOY_STRICT): ${paths.join(", ")}`);
      }, (warnings) => {
        for (const w of warnings) console.error(`[personas] warning: ${w}`);
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
