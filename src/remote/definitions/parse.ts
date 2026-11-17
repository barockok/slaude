/**
 * Parse `environments/<name>.yaml`: one shared ssh machine.
 *
 * Throws PayloadError for anything malformed. Messages name the environment and
 * the key, never the value (a host is sensitive; a value may be a secret). The
 * canonical config and hash it returns decide whether a resync is a no-op.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { parse as parseYaml, YAMLParseError } from "yaml";
import type { ZodIssue } from "zod";
import { classifyAddress } from "../../net/outbound-policy";
import { PayloadError, safeKey } from "../../persona/sync/payload";
import { looksLikeCredential } from "../../secrets/token-shape";
import { sshKind } from "../kinds/ssh";
import { ENV_DEF_NAME_RE, EnvironmentDefinitionSchema } from "./schema";

export interface ParsedEnvironmentDefinition {
  name: string;
  description: string | null;
  kind: "ssh";
  defaultDir: string;
  /** Canonical non-secret config as stored (host, user, port, hostKey, shared, trust, allowPrivateAddress). */
  config: Record<string, string>;
  /** Hash of the canonical definition: key order in the file does not change it. */
  hash: string;
}

const KNOWN_TOP = new Set(["name", "description", "kind", "shared", "trust", "defaultDir", "ssh"]);
const KNOWN_SSH = new Set(["host", "user", "port", "hostKey", "allowPrivateAddress"]);
/** A key named like something that holds a secret. */
const SECRET_KEY_RE = /(secret|token|passw|passphrase|credential|private|identity|keyfile|key_file|apikey|api_key|pem|auth)|key$/i;
const NUMERIC_LABEL_RE = /^(?:0x[0-9a-f]+|[0-9]+)$/i;

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The file's base name, echoed only when it is a valid name. */
const labelOf = (file: string) => (ENV_DEF_NAME_RE.test(file) ? file : "<invalid-name>");

function firstIssue(issues: ZodIssue[]): { path: string; message: string } {
  const unknown = issues.filter((i) => i.code === "unrecognized_keys").sort((a, b) => a.path.length - b.path.length)[0];
  const issue = unknown ?? issues[0]!;
  const base = issue.path.map(String).join(".");
  if (issue.code === "unrecognized_keys") {
    return { path: `${base ? `${base}.` : ""}${safeKey(String(issue.keys[0] ?? ""))}`, message: "is not a known key" };
  }
  return { path: base, message: issue.message };
}

/** Why a host literal or name is refused without allowPrivateAddress, or undefined. Fixed words, never the address. */
function addressProblem(host: string): string | undefined {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (isIP(h)) {
    const kind = classifyAddress(h);
    return kind === null ? undefined : `a ${kind} address`;
  }
  if (h === "localhost" || h.endsWith(".localhost")) return "a loopback name";
  // inet_aton forms (2130706433, 0x7f.1) reach a resolver as an address, not a name.
  if (h.split(".").every((l) => NUMERIC_LABEL_RE.test(l))) return "a numeric address in a form that is not a plain IP literal";
  return undefined;
}

export function canonicalDefinition(d: Pick<ParsedEnvironmentDefinition, "name" | "description" | "kind" | "defaultDir" | "config">): string {
  const config = Object.fromEntries(Object.entries(d.config).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify({ name: d.name, description: d.description, kind: d.kind, defaultDir: d.defaultDir, config });
}

export const definitionHash = (d: Parameters<typeof canonicalDefinition>[0]): string =>
  createHash("sha256").update(canonicalDefinition(d)).digest("hex");

/** `file` is the base name of `environments/<file>.yaml` (without the extension). */
export function parseEnvironmentYaml(file: string, text: string): ParsedEnvironmentDefinition {
  const who = `environment '${labelOf(file)}'`;
  const fail = (key: string, why: string): never => {
    throw new PayloadError(`${who}: ${key ? `${key} ` : ""}${why}`);
  };
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    const where = e instanceof YAMLParseError ? `${e.code}${e.linePos ? ` at line ${e.linePos[0].line}` : ""}` : "unreadable";
    throw new PayloadError(`${who}: not valid YAML (${where})`);
  }
  if (!isMap(raw)) return fail("", "must be a mapping of the environment's fields");

  // A kind this slice does not take: refused with a stated reason before keys are judged (a tailcat file has an `addr` key).
  if (raw.kind === "tailcat" || raw.kind === "provisioned") {
    return fail("kind", `${raw.kind} is not supported for shared environments yet: only ssh is`);
  }

  // Secrets: no key holds one, and no value may look like one.
  const secretKeyRefusal = (path: string) =>
    fail(path, "looks like a secret. An environment file has no key for a private key, password or token: slaude generates the key pair, and only the public key is shown");
  for (const [k, v] of Object.entries(raw)) {
    if (!KNOWN_TOP.has(k) && SECRET_KEY_RE.test(k)) secretKeyRefusal(safeKey(k));
    if (k === "ssh" && isMap(v)) {
      for (const sk of Object.keys(v)) if (!KNOWN_SSH.has(sk) && SECRET_KEY_RE.test(sk)) secretKeyRefusal(`ssh.${safeKey(sk)}`);
    }
  }
  const valueRefusal = (path: string) => fail(path, "has a value that looks like a token or private key. Environment files never carry secrets: slaude generates the key pair, and only the public key is shown");
  for (const [k, v] of Object.entries(raw)) {
    // `name` is vetted by its own pattern (a 41 character name is a long run by nature).
    if (k !== "name" && typeof v === "string" && looksLikeCredential(v)) valueRefusal(safeKey(k));
    if (k === "ssh" && isMap(v)) {
      // The host key fingerprint is long base64 by nature; its own pattern vets it.
      for (const [sk, sv] of Object.entries(v)) if (sk !== "hostKey" && typeof sv === "string" && looksLikeCredential(sv)) valueRefusal(`ssh.${safeKey(sk)}`);
    }
  }

  const checked = EnvironmentDefinitionSchema.safeParse(raw);
  if (!checked.success) {
    const i = firstIssue(checked.error.issues);
    return fail(i.path, i.message);
  }
  const d = checked.data;
  if (d.name !== file) fail("name", "must equal the file name (environments/<name>.yaml)");

  // The same field rules as /env add, so a definition cannot drift from it.
  const parsed = sshKind.parse({ host: d.ssh.host, user: d.ssh.user, port: String(d.ssh.port ?? 22), hostKey: d.ssh.hostKey });
  if (!parsed.ok) {
    const field = /^That doesn't look like a host/.test(parsed.error) ? "host" : /^The user/.test(parsed.error) ? "user" : /^The port/.test(parsed.error) ? "port" : "hostKey";
    return fail(`ssh.${field}`, "is not valid");
  }
  const host = parsed.config.host!;
  const why = addressProblem(host);
  if (why && d.ssh.allowPrivateAddress !== true) {
    return fail("ssh.host", `is ${why}, which a shared environment refuses unless allowPrivateAddress: true is written beside it`);
  }
  const config: Record<string, string> = {
    ...parsed.config,
    shared: "true",
    trust: "unlocked",
    ...(d.ssh.allowPrivateAddress === true ? { allowPrivateAddress: "true" } : {}),
  };
  const def = { name: d.name, description: d.description ?? null, kind: "ssh" as const, defaultDir: d.defaultDir, config };
  return { ...def, hash: definitionHash(def) };
}
