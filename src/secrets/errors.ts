/**
 * Typed resolution failures. A later layer maps every one of these to the
 * single job failure code PROVIDER_CREDENTIALS_UNAVAILABLE; the reason stays
 * internal (logs, tests) and never reaches Slack. Messages never carry a
 * secret value, and never a Vault path or field either: the event log is the
 * place for the persona and the reason, nothing more.
 */
export type SecretFailureReason =
  /** the reference does not parse (re-checked at resolution) */
  | "invalid_ref"
  /** a vault:// ref but this process has no Vault configured */
  | "disabled"
  /** the ref's path is under no configured mount */
  | "no_mount"
  /** refused by SLAUDE_VAULT_ALLOWED_PREFIXES before any network call */
  | "prefix"
  /** env:// variable unset or empty */
  | "env_missing"
  /** Vault: no secret at the path (404, or a deleted/destroyed version) */
  | "missing_secret"
  /** Vault: the secret exists but has no such field */
  | "missing_field"
  /** Vault: the field is not a string */
  | "non_string"
  /** Vault: the mount answered without data.data — a KV v1 mount */
  | "kv_v1"
  /** Vault: 403 with a token that lookup-self says is valid (policy) */
  | "denied"
  /** Vault: could not log in, renew or present a valid token */
  | "auth"
  /** Vault: connection refused, DNS, TLS */
  | "unreachable"
  /** Vault: no answer within the request timeout */
  | "timeout"
  /** Vault: 5xx (including sealed / standby errors) */
  | "server_error"
  /** Vault: an answer we cannot interpret (bad JSON, unexpected 4xx) */
  | "bad_response";

export class SecretResolutionError extends Error {
  override readonly name = "SecretResolutionError";
  constructor(
    readonly reason: SecretFailureReason,
    message: string,
  ) {
    super(message);
  }
}

/** Reasons that mean "Vault is not answering right now", as opposed to a
 *  definitive answer about the secret. Only these may serve a stale value. */
export const TRANSIENT_REASONS: ReadonlySet<SecretFailureReason> = new Set([
  "auth",
  "unreachable",
  "timeout",
  "server_error",
  "bad_response",
]);
