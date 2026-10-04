/**
 * The allowed-prefix rule (WS-A §6.3) and the mount split.
 *
 * Mount split rule. A vault ref is `vault://<mount>/<path>#<field>` where the
 * mount may be several segments, so the split cannot be read off the string.
 * It is decided by configuration: the mount is the LONGEST configured mount
 * (SLAUDE_VAULT_MOUNTS, default: the first segment of each allowed prefix)
 * that is a whole-segment prefix of the ref's path, and at least one path
 * segment must remain after it. Nested configured mounts (`team` and
 * `team/kv`) are refused at config load as ambiguous — Vault itself does not
 * allow one mount under another, so a nested pair is always a mistake.
 *
 * Allowlist check. A ref resolves only if the FINAL request path,
 * `<mount>/data/<path>`, equals an allowed prefix (rewritten to the same
 * `<mount>/data/<prefix-path>` shape) or continues it at a `/` boundary, so
 * `…/personas` never admits `…/personas-evil`. `{persona}` is a whole path
 * segment in a prefix and expands to the persona's name, which must itself be
 * a valid persona name; otherwise the prefix matches nothing.
 */
import { PERSONA_NAME_RE } from "../persona/sync/payload";
import { SecretResolutionError } from "./errors";
import { checkVaultPath, type VaultRef } from "./ref";

export const PERSONA_TOKEN = "{persona}";

export class VaultConfigError extends Error {
  override readonly name = "VaultConfigError";
}

export type AllowedPrefix = {
  /** the configured mount this prefix sits under */
  mount: string;
  /** the path below the mount, may contain the `{persona}` segment */
  pathPrefix: string;
};

/** Parse SLAUDE_VAULT_ALLOWED_PREFIXES against the configured mounts. */
export function parseAllowedPrefixes(raw: string, mounts: readonly string[]): AllowedPrefix[] {
  const out: AllowedPrefix[] = [];
  for (const entry0 of raw.split(",")) {
    const entry = entry0.trim().replace(/\/$/, "");
    if (entry === "") continue;
    // `{persona}` is the only non-path token; check the rest of the entry as a path.
    const segments = entry.split("/");
    for (const s of segments) {
      if (s.includes("{") || s.includes("}")) {
        if (s !== PERSONA_TOKEN) {
          throw new VaultConfigError(`SLAUDE_VAULT_ALLOWED_PREFIXES: ${PERSONA_TOKEN} must be a whole path segment`);
        }
      }
    }
    const checked = checkVaultPath(segments.map((s) => (s === PERSONA_TOKEN ? "persona" : s)).join("/"));
    if ("error" in checked) {
      throw new VaultConfigError(`SLAUDE_VAULT_ALLOWED_PREFIXES: an entry ${checked.error}`);
    }
    const mount = longestMount(segments, mounts);
    if (!mount) {
      throw new VaultConfigError(
        `SLAUDE_VAULT_ALLOWED_PREFIXES: an entry is under no configured mount (SLAUDE_VAULT_MOUNTS)`,
      );
    }
    const mountLen = mount.split("/").length;
    if (segments.slice(0, mountLen).includes(PERSONA_TOKEN)) {
      throw new VaultConfigError(`SLAUDE_VAULT_ALLOWED_PREFIXES: ${PERSONA_TOKEN} must not be part of the mount`);
    }
    if (segments.length === mountLen) {
      throw new VaultConfigError(
        `SLAUDE_VAULT_ALLOWED_PREFIXES: an entry names a whole mount; give '<mount>/<path-prefix>'`,
      );
    }
    out.push({ mount, pathPrefix: segments.slice(mountLen).join("/") });
  }
  return out;
}

function longestMount(segments: readonly string[], mounts: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestLen = 0;
  for (const m of mounts) {
    const ms = m.split("/");
    if (ms.length > segments.length) continue;
    if (ms.every((s, i) => segments[i] === s) && ms.length > bestLen) {
      best = m;
      bestLen = ms.length;
    }
  }
  return best;
}

/** Split a ref's path into mount and in-mount path (see the rule above). */
export function splitMount(path: string, mounts: readonly string[]): { mount: string; path: string } {
  const segments = path.split("/");
  const mount = longestMount(segments, mounts);
  const rest = mount ? segments.slice(mount.split("/").length) : [];
  if (!mount || rest.length === 0) {
    throw new SecretResolutionError("no_mount", "secret reference is under no configured Vault mount");
  }
  return { mount, path: rest.join("/") };
}

/** The final KV v2 request path for a ref: `<mount>/data/<path>`. */
export function requestPathFor(ref: VaultRef, mounts: readonly string[]): string {
  const { mount, path } = splitMount(ref.path, mounts);
  return `${mount}/data/${path}`;
}

/** Whether `finalRequestPath` (`<mount>/data/<path>`) is inside an allowed prefix for `persona`. */
export function isAllowed(finalRequestPath: string, persona: string, prefixes: readonly AllowedPrefix[]): boolean {
  // Defence in depth: the resolver only builds paths from parsed refs, but a
  // path that would not survive parsing is never inside anything.
  if ("error" in checkVaultPath(finalRequestPath)) return false;
  const personaOk = PERSONA_NAME_RE.test(persona);
  for (const p of prefixes) {
    const segs = p.pathPrefix.split("/");
    if (segs.includes(PERSONA_TOKEN) && !personaOk) continue;
    const expanded = segs.map((s) => (s === PERSONA_TOKEN ? persona : s)).join("/");
    const allowed = `${p.mount}/data/${expanded}`;
    if (finalRequestPath === allowed || finalRequestPath.startsWith(`${allowed}/`)) return true;
  }
  return false;
}
