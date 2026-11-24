/**
 * The node-local stdio MCP manifest (node labels spec §4.10).
 *
 * A node mounts a stdio MCP server only when this manifest declares it AND
 * allows it for the session's persona. It is the single source of stdio
 * servers on a node: an installed plugin's MCP servers are not read from disk
 * here, so a plugin server must be declared in the manifest by name and
 * command to run at all. The gateway never reads this file.
 *
 *   {
 *     "version": 1,
 *     "mcpServers": { "gh": { "command": "gh-mcp", "env": { "GH_HOST": "${NODE_GH_HOST}" } } },
 *     "allow": { "support-bot": ["gh"], "ops-bot": "*" }
 *   }
 *
 * - A persona not listed in `allow` gets nothing; `"*"` is every server.
 * - The persona is the one in the session's job token claims, never the
 *   unsigned persona id in the queue payload. The node cannot verify a token
 *   (it holds no job secret), so before mounting anything it fetches that
 *   persona's runtime bundle with the token: the gateway answers only a token
 *   it signed for that persona.
 * - A plain `${VAR}` in an `env` value is expanded once, at node start, from
 *   the node's own environment. A variable the agent child is scrubbed of
 *   (every gateway-only name, the node token, the Redis URL) can never be
 *   expanded.
 * - The CLI expands `${VAR}` and `${VAR:-default}` in a stdio config's command,
 *   args and env values AGAIN, against the agent child's environment (the
 *   persona's provider credentials included). So no `${` may survive into the
 *   config: one in command or args, a default or modifier form, or an expanded
 *   value containing `${` refuses the manifest; the final config is checked
 *   once more for anything arriving from outside the file.
 * - A server is started through the exec wrapper (./mcp-exec.ts) with an
 *   explicit minimal environment: its own `env` plus PATH, HOME, LANG and
 *   TMPDIR from the node, and nothing the agent child inherited.
 *
 * Read and validated once at node start; a change needs a pod roll. An absent
 * file is the empty manifest.
 */
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { isChildScrubbedEnv } from "../agent/child-env";
import { env as appEnv } from "../config/env";
import { CLI_REF, STDIO_ENV_KEY_RE, STDIO_ENV_REF_RE, STDIO_SERVER_NAME_RE, hasNonPlainRef, validateStdioServer } from "../config/stdio-server";
import { BootFailure } from "../gateway/core/failure-codes";
import type { BoxStdioServer } from "../box/policy";
import { type NodeClient, bundleFetchFailure } from "./client";
import { decodeClaims } from "./remote";

export const NODE_MANIFEST_DEFAULT_PATH = "/etc/slaude/node.json";
// The name and key patterns and the `${` rules are shared with a box's
// mcp.stdio (src/config/stdio-server.ts, validateStdioServer).
const SERVER_NAME_RE = STDIO_SERVER_NAME_RE;
const ENV_KEY_RE = STDIO_ENV_KEY_RE;
const ENV_REF_RE = STDIO_ENV_REF_RE;
const CLI_REFUSAL = "the CLI would expand it again against the agent child's environment";
/** The node variables every stdio server gets, besides its own `env`. */
export const MINIMAL_ENV_NAMES = ["PATH", "HOME", "LANG", "TMPDIR"] as const;
/** The exec wrapper a stdio server is started through. */
export const MCP_EXEC_ENTRY = fileURLToPath(new URL("./mcp-exec.ts", import.meta.url));
/** Bun runtime flags for the wrapper. The CLI starts a stdio server in the
 *  session workspace, which the agent can write, and Bun reads `bunfig.toml`
 *  (a `preload` runs code before the wrapper) and `.env` from the cwd: an
 *  explicit empty config and no env file make the wrapper ignore both. */
export const MCP_EXEC_BUN_FLAGS = ["--config=/dev/null", "--no-env-file", "--no-install"] as const;

export class NodeManifestError extends Error {
  override name = "NodeManifestError";
}

/** A declared server after validation and `${VAR}` expansion. */
export interface NodeStdioServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface NodeManifest {
  servers: Record<string, NodeStdioServer>;
  allow: Record<string, readonly string[] | "*">;
}

export const EMPTY_NODE_MANIFEST: NodeManifest = Object.freeze({ servers: {}, allow: {} }) as NodeManifest;

const serverName = z.string().regex(SERVER_NAME_RE, "must match ^[a-z0-9][a-z0-9_-]{0,63}$");
const StdioServer = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string().regex(ENV_KEY_RE, "must be a variable name"), z.string()).optional(),
    type: z.literal("stdio", { errorMap: () => ({ message: "only stdio servers are allowed on a node" }) }).optional(),
  })
  .strict();
const ManifestSchema = z
  .object({
    version: z.literal(1, { errorMap: () => ({ message: "must be 1" }) }),
    mcpServers: z.record(serverName, StdioServer).default({}),
    allow: z.record(z.string().min(1, "a persona name is required"), z.union([z.literal("*"), z.array(serverName)])).default({}),
  })
  .strict();

/** A zod issue as `path: reason`, never a received value (an env value may be a secret). */
function describeIssue(i: z.ZodIssue): string {
  const path = i.path.length ? i.path.join(".") : "(root)";
  if (i.code === "unrecognized_keys") return `${path}: unknown key(s) ${i.keys.join(", ")}`;
  if (i.code === "invalid_type") return `${path}: expected ${i.expected}, got ${i.received}`;
  if (i.code === "invalid_union") return `${path}: must be "*" or a list of server names`;
  return `${path}: ${i.message}`;
}

/**
 * Duplicate object keys in the JSON text. JSON.parse keeps the last one
 * silently, so `"gh"` declared twice would run whichever came second. The text
 * is already known to be valid JSON.
 */
function duplicateKey(text: string): string | null {
  const stack: Array<{ keys: Set<string> | null; expectKey: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top?.keys && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) return key;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j;
    } else if (c === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (c === "[") stack.push({ keys: null, expectKey: false });
    else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") {
      const top = stack[stack.length - 1];
      if (top?.keys) top.expectKey = true;
    }
  }
  return null;
}

/** Expand plain `${VAR}` from the node's environment. Refuses a scrubbed name,
 *  an unset variable, any other `${` form, and a result still holding `${` —
 *  naming the field and variable, never a value. */
function expandEnv(where: string, raw: Record<string, string>, nodeEnv: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isChildScrubbedEnv(key)) {
      throw new NodeManifestError(`${where}.${key}: ${key} is a gateway-only or node-held variable and may not be given to a stdio server`);
    }
    if (hasNonPlainRef(value)) {
      throw new NodeManifestError(
        `${where}.${key}: only a plain \${NAME} reference is expanded; a default, a modifier or an unterminated "\${" is refused (${CLI_REFUSAL})`,
      );
    }
    out[key] = value.replace(ENV_REF_RE, (_m, name: string) => {
      if (isChildScrubbedEnv(name)) {
        throw new NodeManifestError(
          `${where}.${key}: references ${name}, a gateway-only or node-held variable that is never expanded into a stdio server's env`,
        );
      }
      const v = nodeEnv[name];
      if (v === undefined) throw new NodeManifestError(`${where}.${key}: references ${name}, which is not set in this node's environment`);
      return v;
    });
    if (out[key]!.includes(CLI_REF)) {
      throw new NodeManifestError(`${where}.${key}: its expanded value contains "\${" (${CLI_REFUSAL})`);
    }
  }
  return out;
}

/** Refuse `${` in a field slaude does not expand (command, args). */
function refuseCliRef(where: string, value: string): void {
  if (value.includes(CLI_REF)) {
    throw new NodeManifestError(`${where}: contains "\${", which is expanded only in env values (${CLI_REFUSAL}); use an absolute path or an env variable`);
  }
}

/** Parse and validate manifest text; `source` names it in errors. Throws NodeManifestError. */
export function parseNodeManifest(text: string, nodeEnv: Record<string, string | undefined>, source: string): NodeManifest {
  const fail = (msg: string): never => {
    throw new NodeManifestError(`node manifest ${source}: ${msg}`);
  };
  if (text.charCodeAt(0) === 0xfeff) fail("the manifest has a byte-order mark (save it as UTF-8 without one)");
  if (text.trim() === "") fail("the file is empty (delete it for no servers, or write {\"version\": 1})");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("not valid JSON");
  }
  const dup = duplicateKey(text);
  if (dup !== null) fail(`duplicate key '${dup}'`);
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues.map(describeIssue).join("; "));
  const m = parsed.data;

  const servers: Record<string, NodeStdioServer> = {};
  try {
    for (const [name, s] of Object.entries(m.mcpServers)) {
      // The shared check, for the fields slaude does not expand (the schema above
      // already settled names and shapes). Env values are checked key by key
      // in expandEnv, beside the checks that need this node's environment.
      for (const issue of validateStdioServer(name, s, "node")) {
        if (issue.code === "cli-ref") refuseCliRef(`mcpServers.${name}.${issue.field}`, CLI_REF);
      }
      servers[name] = { command: s.command, args: s.args ?? [], env: expandEnv(`mcpServers.${name}.env`, s.env ?? {}, nodeEnv) };
    }
    // The base variables every server gets come from this node's environment.
    if (Object.keys(servers).length > 0) {
      for (const k of MINIMAL_ENV_NAMES) {
        if (nodeEnv[k]?.includes(CLI_REF)) throw new NodeManifestError(`${k} in this node's environment contains "\${" (${CLI_REFUSAL})`);
      }
    }
  } catch (e) {
    fail((e as Error).message);
  }
  const allow: Record<string, readonly string[] | "*"> = {};
  for (const [persona, entry] of Object.entries(m.allow)) {
    if (entry !== "*") {
      const seen = new Set<string>();
      for (const n of entry) {
        if (!Object.hasOwn(servers, n)) fail(`allow.${persona}: names '${n}', which is not in mcpServers`);
        if (seen.has(n)) fail(`allow.${persona}: duplicate server '${n}'`);
        seen.add(n);
      }
    }
    allow[persona] = entry;
  }
  return { servers, allow };
}

/** SLAUDE_NODE_MANIFEST, or the default path when unset or empty. */
export function nodeManifestPath(): string {
  return appEnv.nodeManifestPath() || NODE_MANIFEST_DEFAULT_PATH;
}

/** One boot log line: counts and names, never an env value. */
export function describeNodeManifest(m: NodeManifest, path: string = nodeManifestPath()): string {
  const servers = Object.keys(m.servers);
  if (servers.length === 0) return `node manifest ${path}: no stdio MCP servers (no plugin MCP server is mounted for any persona)`;
  const personas = Object.keys(m.allow);
  return `node manifest ${path}: ${servers.length} stdio MCP server(s) [${servers.join(", ")}], allowed for ${personas.length} persona(s) [${personas.join(", ")}]`;
}

/** Read the manifest at node start. An absent file is the empty manifest. */
export function loadNodeManifest(
  path: string = nodeManifestPath(),
  nodeEnv: Record<string, string | undefined> = process.env,
): NodeManifest {
  let text: string;
  try {
    if (!statSync(path).isFile()) throw new NodeManifestError(`node manifest ${path}: cannot be read (not a file)`);
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_NODE_MANIFEST;
    if (e instanceof NodeManifestError) throw e;
    throw new NodeManifestError(`node manifest ${path}: cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  return parseNodeManifest(text, nodeEnv, path);
}

/** The server names a persona may mount: its own list, every server for "*", none when unlisted. */
export function allowedServers(m: NodeManifest, persona: string): string[] {
  if (!Object.hasOwn(m.allow, persona)) return [];
  const entry = m.allow[persona]!;
  return entry === "*" ? Object.keys(m.servers) : [...entry];
}

/**
 * The SDK configs for a persona's allowed servers. Each runs through the exec
 * wrapper, which starts the real command with exactly the variables named in
 * its argv: the minimal node set plus the server's own `env`. The values ride
 * in the config's `env`, not in the wrapper's argv.
 */
export function stdioServersFor(
  m: NodeManifest,
  persona: string,
  nodeEnv: Record<string, string | undefined> = process.env,
  execPath: string = process.execPath,
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const name of allowedServers(m, persona)) {
    const s = m.servers[name]!;
    const env: Record<string, string> = {};
    for (const k of MINIMAL_ENV_NAMES) if (nodeEnv[k] !== undefined) env[k] = nodeEnv[k]!;
    Object.assign(env, s.env);
    const cfg = {
      type: "stdio" as const,
      command: execPath,
      args: [...MCP_EXEC_BUN_FLAGS, MCP_EXEC_ENTRY, Object.keys(env).join(","), "--", s.command, ...s.args],
      env,
    };
    // The last word: nothing in what the CLI receives may be expandable.
    refuseCliRef(`mcpServers.${name}: the exec path`, cfg.command);
    cfg.args.forEach((a, i) => refuseCliRef(`mcpServers.${name}: wrapper argument ${i}`, a));
    for (const [k, v] of Object.entries(env)) {
      if (k.includes(CLI_REF) || v.includes(CLI_REF)) throw new NodeManifestError(`mcpServers.${name}.env.${k}: contains "\${" (${CLI_REFUSAL})`);
    }
    out[name] = cfg;
  }
  return out;
}

/**
 * The SDK configs of a BOXED session's stdio servers: the box's `mcp.stdio`,
 * as the gateway sent it in the bundle. They start inside the sandbox as
 * children of the CLI, with the box's environment, so there is no exec
 * wrapper and no `env`: a box holds no credential to keep away from a server.
 *
 * The gateway vetted the box at sync. The node checks again what it received
 * (the stricter box form: no `${` anywhere), because the CLI would expand one.
 * A failed check fails the boot; it never drops the server and runs on.
 */
export function boxStdioServers(stdio: Readonly<Record<string, BoxStdioServer>>): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, s] of Object.entries(stdio)) {
    const issues = validateStdioServer(name, s, "box");
    if (issues.length) {
      // The name is echoed only when it is one; a field is named, never a value.
      const label = STDIO_SERVER_NAME_RE.test(name) ? name : "(invalid name)";
      throw new BootFailure("BOX_UNAVAILABLE", `the box's stdio server '${label}' was refused on the node: ${issues.map((i) => `${i.field} (${i.code})`).join(", ")}`);
    }
    if (!s.command.startsWith("/")) {
      throw new BootFailure("BOX_UNAVAILABLE", `the box's stdio server '${name}' was refused on the node: command is not an absolute path`);
    }
    out[name] = { type: "stdio" as const, command: s.command, args: [...s.args] };
  }
  return out;
}

export interface NodeLocalMcpDeps {
  /** The node manifest; null when the node has none (it then serves boxed sessions' servers only). */
  manifest: NodeManifest | null;
  /**
   * The session's box, when it runs in one (src/box/session-box.ts). A boxed
   * session gets the box's servers and never the manifest's. Absent: no
   * session of this node is boxed (tier `none`).
   */
  boxOf?: (sessionId: string) => Promise<{ name: string; policy: { mcp: { stdio: Readonly<Record<string, BoxStdioServer>> } } } | null>;
  /** One line per persona that is both boxed and allowed in the manifest. Default: console.warn. */
  warn?: (line: string) => void;
  client: Pick<NodeClient, "getRuntime">;
  tenantFor: (sessionId: string) => string | undefined;
  tokenFor: (sessionId: string) => string | undefined;
  nodeEnv?: Record<string, string | undefined>;
  execPath?: string;
}

/**
 * The node's per-session stdio servers. The persona is the job token's claim;
 * the runtime-bundle fetch with that token for that persona is the check that
 * the claim is the gateway's (the endpoint answers 403 for a token scoped to
 * another persona, 401 for one it did not sign). A refusal fails the boot,
 * classified transient or definitive as the child-env resolver's is.
 */
export function makeNodeLocalMcpResolver(deps: NodeLocalMcpDeps): (sessionId: string) => Promise<Record<string, McpServerConfig>> {
  const manifest = deps.manifest ?? EMPTY_NODE_MANIFEST;
  const warned = new Set<string>();
  return async (sessionId) => {
    const token = deps.tokenFor(sessionId);
    const tenant = deps.tenantFor(sessionId);
    const persona = token ? decodeClaims(token)?.persona : undefined;
    // A boxed session: the box's own servers, from the bundle the gateway
    // answered this session's token with (boxOf reads it, which is the same
    // check of the persona claim the manifest path makes below). The manifest
    // is not consulted: its servers run on the node, outside the sandbox.
    const box = deps.boxOf ? await deps.boxOf(sessionId) : null;
    if (box) {
      if (persona && !warned.has(persona) && allowedServers(manifest, persona).length > 0) {
        warned.add(persona);
        (deps.warn ?? console.warn)(
          `[node] persona=${persona} runs in box '${box.name}' and is also allowed stdio servers in the node manifest: a boxed session ignores the manifest (declare the servers in the box's mcp.stdio, or move a server that needs a credential behind the gateway)`,
        );
      }
      return boxStdioServers(box.policy.mcp.stdio);
    }
    if (!token || !tenant || !persona) return {};
    if (allowedServers(manifest, persona).length === 0) return {};
    try {
      await deps.client.getRuntime(tenant, persona, token);
    } catch (e) {
      throw bundleFetchFailure(e);
    }
    return stdioServersFor(manifest, persona, deps.nodeEnv, deps.execPath);
  };
}
