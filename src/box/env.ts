/**
 * The environment of a boxed spawn (box spec, "What spawn does to the
 * environment").
 *
 * The Agent SDK hands the spawn hook the child's environment, which on a node
 * holds provider credentials. A box's environment is BUILT FROM NOTHING, never
 * filtered from that one: a name reaches a box only because a rule below puts
 * it there. No rule copies a credential, and there is no flag that makes one.
 *
 * What a box gets:
 *   - from the image config: PATH;
 *   - fixed: HOME, LANG, TMPDIR and SLAUDE_SCRATCH (the session's scratch
 *     directory), CLAUDE_CONFIG_DIR (the session's config directory, at its
 *     unchanged path);
 *   - the egress proxy variables, all pointing at box-init's loopback relay;
 *   - ANTHROPIC_BASE_URL pointing at the provider proxy's relay, and a
 *     PLACEHOLDER in the credential variable of the persona's provider form, so
 *     the CLI behaves as it would with the real one. The real credential stays
 *     in the node worker's provider proxy;
 *   - from the SDK's environment: CLAUDE_* names that carry no credential,
 *     ANTHROPIC_* model names, and a few exact names (the agent id);
 *   - from the box: its reviewed, non-secret `env`.
 *
 * Stricter than the spec's wording in one place, on purpose: the spec passes
 * every ANTHROPIC_* and CLAUDE_* name outside PROVIDER_ENV_KEYS. The bundled
 * CLI keeps adding provider modes with their own keys and switches under those
 * prefixes (see PROVIDER_SELECTING_ENV_PREFIXES), so here an ANTHROPIC_* name
 * passes only when it is a model name, a CLAUDE_* name never passes when it
 * belongs to a provider-selecting family or reads like a credential, and no
 * copied value may be shaped like a secret.
 */
import { isChildScrubbedEnv } from "../agent/child-env";
import { PROVIDER_ENV_KEYS, PROVIDER_SELECTING_ENV_NAMES } from "../agent/provider-env";
import { redactSecrets } from "../redact";
import type { BoxPolicy } from "./policy";

/** How a persona authenticates to its model provider. */
export type ProviderForm = "api-key" | "auth-token" | "oauth-token";

/** The variable the CLI reads for each form. */
export const PROVIDER_FORM_ENV: Readonly<Record<ProviderForm, string>> = {
  "api-key": "ANTHROPIC_API_KEY",
  "auth-token": "ANTHROPIC_AUTH_TOKEN",
  "oauth-token": "CLAUDE_CODE_OAUTH_TOKEN",
};

/**
 * What the credential variable holds in a box. Not a secret and not derived
 * from one: the provider proxy strips whatever the box sends and adds the real
 * credential outside the box.
 * TODO(box spike 3, scripts/spike/box/03-provider.ts): if the CLI validates
 * the shape of a credential locally, this takes the shape the spike records.
 */
export const BOX_CREDENTIAL_PLACEHOLDER = "slaude-box-placeholder";

/** box-init relays these two loopback ports to the session's two sockets. */
export const BOX_EGRESS_PROXY_URL = "http://127.0.0.1:3128";
export const BOX_PROVIDER_PROXY_URL = "http://127.0.0.1:3129";

export const BOX_HOME = "/home/agent";
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_LANG = "C.UTF-8";
const NO_PROXY = "127.0.0.1,localhost";

/** The CLI's own outbound traffic: there is no route for it in a box. */
const CLI_QUIET: Readonly<Record<string, string>> = {
  DISABLE_TELEMETRY: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_BUG_COMMAND: "1",
  DISABLE_ERROR_REPORTING: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

/** Exact names copied from the SDK's environment (non-secret switches and ids). */
const SDK_EXACT_NAMES: readonly string[] = ["SLAUDE_AGENT_ID", "ENABLE_TOOL_SEARCH"];

/** CLAUDE_* families that select or authenticate a provider: never copied. */
const CLAUDE_PROVIDER_FAMILIES: readonly string[] = [
  "CLAUDE_CODE_USE_",
  "CLAUDE_CODE_OAUTH_",
  "CLAUDE_CODE_API_KEY_",
  "CLAUDE_CODE_CLIENT_",
];

/** A name that reads like it holds a credential. Deliberately broad. */
const CREDENTIAL_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|HEADER|CERT|SIGNATURE|SESSION_ID/i;

const NEVER_COPIED = new Set<string>([...PROVIDER_ENV_KEYS, ...PROVIDER_SELECTING_ENV_NAMES]);

/** True when a value is shaped like one of the repository's secret shapes. */
export function looksLikeSecret(value: string): boolean {
  return redactSecrets(value) !== value;
}

/** Whether a name from the SDK's environment may be copied into a box. */
export function isBoxCopiedSdkEnvName(name: string): boolean {
  if (NEVER_COPIED.has(name) || isChildScrubbedEnv(name)) return false;
  if (SDK_EXACT_NAMES.includes(name)) return true;
  if (CREDENTIAL_NAME.test(name)) return false;
  if (name.startsWith("ANTHROPIC_")) return name.includes("MODEL");
  if (name.startsWith("CLAUDE_")) return !CLAUDE_PROVIDER_FAMILIES.some((p) => name.startsWith(p));
  return false;
}

export interface BoxEnvInput {
  /** The environment the SDK handed the spawn hook. Read by rule, never spread. */
  sdkEnv: Record<string, string | undefined>;
  /** The image config's environment. Only PATH is used. */
  imageEnv: Record<string, string | undefined>;
  policy: BoxPolicy;
  /** The session's scratch directory, at its node path. */
  scratchDir: string;
  /** The session's config directory, at its node path. */
  configDir: string;
  providerForm: ProviderForm;
}

/** The names the builder owns. A box's `env` cannot set one (the schema refuses it; this ignores it). */
export const BOX_RESERVED_ENV_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "TMPDIR",
  "SLAUDE_SCRATCH",
  "SLAUDE_AGENT_ID",
  "CLAUDE_CONFIG_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
  ...Object.keys(CLI_QUIET),
  ...PROVIDER_SELECTING_ENV_NAMES,
];

/** Whether a box.yaml `env` name is one a box may set. */
export function isBoxEnvNameAllowed(name: string): boolean {
  if (BOX_RESERVED_ENV_NAMES.includes(name)) return false;
  if (isChildScrubbedEnv(name)) return false;
  if (name.startsWith("ANTHROPIC_") || name.startsWith("CLAUDE_") || name.startsWith("SLAUDE_")) return false;
  return true;
}

export function buildBoxEnv(input: BoxEnvInput): Record<string, string> {
  const out: Record<string, string> = {};

  // The box's own env first, so nothing in it can replace what follows.
  for (const [k, v] of Object.entries(input.policy.env)) {
    if (isBoxEnvNameAllowed(k) && typeof v === "string") out[k] = v;
  }

  // From the SDK's environment, by rule.
  for (const [k, v] of Object.entries(input.sdkEnv)) {
    if (typeof v !== "string" || !isBoxCopiedSdkEnvName(k)) continue;
    if (looksLikeSecret(v)) continue;
    out[k] = v;
  }

  // From the image.
  const imagePath = input.imageEnv.PATH;
  out.PATH = typeof imagePath === "string" && imagePath.length > 0 ? imagePath : DEFAULT_PATH;

  // Fixed.
  out.HOME = BOX_HOME;
  out.LANG = DEFAULT_LANG;
  out.TMPDIR = input.scratchDir;
  out.SLAUDE_SCRATCH = input.scratchDir;
  out.CLAUDE_CONFIG_DIR = input.configDir;
  Object.assign(out, CLI_QUIET);

  // Egress: the only route out is box-init's relay to the session's proxy.
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) out[k] = BOX_EGRESS_PROXY_URL;
  out.NO_PROXY = NO_PROXY;
  out.no_proxy = NO_PROXY;
  out.NODE_USE_ENV_PROXY = "1";

  // Provider: the relay to the provider proxy, and a placeholder credential.
  for (const k of NEVER_COPIED) delete out[k];
  out.ANTHROPIC_BASE_URL = BOX_PROVIDER_PROXY_URL;
  out[PROVIDER_FORM_ENV[input.providerForm]] = BOX_CREDENTIAL_PLACEHOLDER;

  return out;
}
