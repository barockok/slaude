/**
 * The checks every stdio MCP server declaration goes through, whichever file
 * declares it: the node manifest (src/node/manifest.ts) and a box's
 * `mcp.stdio` (src/box/definition.ts, and again on the node that receives it).
 *
 * The reason for the `${` rules is one fact about the CLI: it expands `${VAR}`
 * and `${VAR:-default}` in a stdio config's command, args and env values
 * against the environment of the process that starts the server. So a `${`
 * that survives into a config is a way to read that environment.
 *
 *   - `node` form: `${` is refused in the command and the args. An env value
 *     may hold plain `${NAME}` references only, which the node expands itself
 *     once, at start (the manifest does that part; it needs the node's
 *     environment). A default, a modifier or an unterminated `${` is refused.
 *   - `box` form (stricter): no `${` anywhere, and no `env` at all. A server in
 *     a box gets the box's environment and no credential, so there is nothing
 *     to reference.
 *
 * Pure: no environment is read here. An issue names a field, never a value
 * (an env value may be a secret).
 */

/** A server's name, in every file that declares one. */
export const STDIO_SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** An env variable name a server may be given. */
export const STDIO_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A plain reference the node manifest expands. */
export const STDIO_ENV_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** What the CLI would expand (every one of its forms starts with this). */
export const CLI_REF = "${";

export type StdioForm = "node" | "box";

export type StdioIssueCode =
  /** The name does not match {@link STDIO_SERVER_NAME_RE}. */
  | "name"
  /** command is not a non-empty string. */
  | "command"
  /** args is not a list of strings. */
  | "args"
  /** env is not a mapping of names to strings. */
  | "env"
  /** An env key is not a variable name. */
  | "env-key"
  /** `${` in the command or an argument. */
  | "cli-ref"
  /** An env value holds a `${` form other than plain `${NAME}`. */
  | "env-ref-form"
  /** Box form: `${` anywhere. */
  | "box-ref"
  /** Box form: an `env` key on the server. */
  | "box-env"
  /** A key the declaration does not have. The key is not echoed: nothing says it is not a value pasted in the wrong place. */
  | "unknown-key";

export interface StdioIssue {
  code: StdioIssueCode;
  /** Where, relative to the server: `name`, `command`, `args.2`, `env.GH_HOST`. */
  field: string;
}

/** The names an env value references with plain `${NAME}`. */
export function stdioEnvRefs(value: string): string[] {
  return [...value.matchAll(STDIO_ENV_REF_RE)].map((m) => m[1]!);
}

/** True when an env value holds a `${` that is not a plain `${NAME}` reference. */
export function hasNonPlainRef(value: string): boolean {
  return value.replace(STDIO_ENV_REF_RE, "").includes(CLI_REF);
}

const KNOWN_KEYS: Readonly<Record<StdioForm, ReadonlySet<string>>> = {
  node: new Set(["command", "args", "env", "type"]),
  box: new Set(["command", "args"]),
};

/**
 * Every problem of one declaration, in a fixed order: the name, the shape,
 * then the `${` rules for the command, each argument and each env value.
 * An empty list means the declaration passes these checks; each caller adds
 * its own (the manifest: scrubbed variable names and expansion; a box: an
 * absolute command path and secret shapes).
 */
export function validateStdioServer(name: string, config: unknown, form: StdioForm = "node"): StdioIssue[] {
  const issues: StdioIssue[] = [];
  if (!STDIO_SERVER_NAME_RE.test(name) || (form === "box" && name.includes(CLI_REF))) issues.push({ code: "name", field: "name" });
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    issues.push({ code: "command", field: "command" });
    return issues;
  }
  const c = config as { command?: unknown; args?: unknown; env?: unknown };
  for (const k of Object.keys(c)) {
    if (KNOWN_KEYS[form].has(k)) continue;
    issues.push(form === "box" && k === "env" ? { code: "box-env", field: "env" } : { code: "unknown-key", field: "(key)" });
  }
  const refCode: StdioIssueCode = form === "box" ? "box-ref" : "cli-ref";
  if (typeof c.command !== "string" || c.command.length === 0) issues.push({ code: "command", field: "command" });
  else if (c.command.includes(CLI_REF)) issues.push({ code: refCode, field: "command" });
  if (c.args !== undefined) {
    if (!Array.isArray(c.args) || c.args.some((a) => typeof a !== "string")) issues.push({ code: "args", field: "args" });
    else (c.args as string[]).forEach((a, i) => a.includes(CLI_REF) && issues.push({ code: refCode, field: `args.${i}` }));
  }
  if (form === "node" && c.env !== undefined) {
    if (!c.env || typeof c.env !== "object" || Array.isArray(c.env)) issues.push({ code: "env", field: "env" });
    else {
      for (const [key, value] of Object.entries(c.env as Record<string, unknown>)) {
        if (!STDIO_ENV_KEY_RE.test(key)) issues.push({ code: "env-key", field: "env.(key)" });
        else if (typeof value !== "string") issues.push({ code: "env", field: `env.${key}` });
        else if (hasNonPlainRef(value)) issues.push({ code: "env-ref-form", field: `env.${key}` });
      }
    }
  }
  return issues;
}
