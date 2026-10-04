/**
 * Secret reference grammar (WS-A §4, §6.3).
 *
 *   vault://<mount>/<path>#<field>   KV v2; mount is one or more segments
 *   env://PERSONA_<NAME>             the gateway's own environment
 *
 * No other scheme. Parsing is syntax only: it does not know which segments
 * form the mount, because that depends on the Vault configuration
 * (SLAUDE_VAULT_MOUNTS, see config.ts). A parsed vault ref therefore carries
 * the whole `<mount>/<path>` as `path`; the resolver splits it.
 *
 * Normalisation is by refusal, not rewriting: the only accepted spelling of a
 * path is already canonical. Each segment and the field must match
 * [A-Za-z0-9_][A-Za-z0-9_.-]* — ASCII only, so no percent-encoding (in any
 * case or depth), no backslash, no whitespace or control character, no `@`
 * (userinfo), `:` (port), `?` (query) or `{}` (template), and no `.`/`..`
 * segment can be expressed. Empty segments (`//`, a leading or trailing `/`)
 * are refused. The specific checks below exist only to give a precise message.
 *
 * Errors are PayloadErrors (422) so sync can surface them as-is. They name the
 * caller's label (persona and field) and never echo the input.
 */
import { PayloadError } from "../persona/sync/payload";
import { PERSONA_VAR_PREFIX, PERSONA_VAR_RE } from "./persona-var";

export type VaultRef = { scheme: "vault"; path: string; field: string };
export type EnvRef = { scheme: "env"; name: string };
export type SecretRef = VaultRef | EnvRef;

export class SecretRefError extends PayloadError {}

const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const MAX_REF_LENGTH = 1024;

export function canonicalRef(ref: SecretRef): string {
  return ref.scheme === "vault" ? `vault://${ref.path}#${ref.field}` : `env://${ref.name}`;
}

/**
 * Validate a slash-separated Vault path (a ref's path, or an allowlist entry).
 * Returns the segments, or the reason it is refused.
 */
export function checkVaultPath(path: string): { segments: string[] } | { error: string } {
  if (path === "") return { error: "is empty" };
  const segments = path.split("/");
  for (const s of segments) {
    if (s === "") return { error: "has an empty path segment" };
    if (s === "." || s === "..") return { error: "has a '.' or '..' path segment" };
    if (!SEGMENT_RE.test(s)) return { error: "has a path segment outside [A-Za-z0-9_.-]" };
  }
  return { segments };
}

export function parseRef(input: string, label?: string): SecretRef {
  const fail = (why: string): never => {
    throw new SecretRefError(`${label ? `${label}: ` : ""}secret reference ${why}`);
  };
  if (typeof input !== "string" || input === "") fail("must be a non-empty string");
  if (input.length > MAX_REF_LENGTH) fail("is too long");
  // Whole-input checks first, for precise messages.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(input)) fail("contains a control character");
  if (/\s/.test(input)) fail("contains whitespace");
  if (/[^ -~]/.test(input)) fail("contains a non-ASCII character");
  if (input.includes("%")) fail("contains percent-encoding");
  if (input.includes("\\")) fail("contains a backslash");
  if (input.includes("?")) fail("contains a query string");

  if (input.startsWith("env://")) {
    const name = input.slice("env://".length);
    if (!PERSONA_VAR_RE.test(name)) {
      fail(`env:// names must start with ${PERSONA_VAR_PREFIX} and contain only A-Z, 0-9 and _`);
    }
    return { scheme: "env", name };
  }

  if (!input.startsWith("vault://")) fail("must use the vault:// or env:// scheme");
  const body = input.slice("vault://".length);
  const hash = body.indexOf("#");
  if (hash < 0) fail("is missing '#<field>'");
  if (body.indexOf("#", hash + 1) >= 0) fail("has more than one '#'");
  const path = body.slice(0, hash);
  const field = body.slice(hash + 1);
  if (field === "") fail("has an empty field after '#'");
  if (!SEGMENT_RE.test(field)) fail("field must match [A-Za-z0-9_][A-Za-z0-9_.-]*");
  if (path.includes("@")) fail("must not contain userinfo ('@')");
  const checked = checkVaultPath(path);
  if ("error" in checked) fail(`path ${checked.error}`);
  if ((checked as { segments: string[] }).segments.length < 2) fail("needs a mount and a path ('<mount>/<path>')");
  return { scheme: "vault", path, field };
}
