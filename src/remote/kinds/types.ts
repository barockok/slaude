import type { ConnectInfo, HelperTransport } from "../transport";
import type { EnvTrust } from "../types";

/** One input of a kind's /env add form (a Slack modal field or a `key=value`
 *  argument). Values are never echoed in a thread. */
export interface FieldSpec {
  id: string;
  label: string;
  hint?: string;
  placeholder?: string;
  optional?: boolean;
}

/** A saved environment as a kind sees it: secrets decrypted, in memory only. */
export interface StoredEnv {
  id: string;
  teamId: string;
  userId: string;
  name: string;
  kind: string;
  /** Non-secret config. May hold an address: never echo it. */
  config: Record<string, string>;
  secrets: Record<string, string>;
  defaultDir: string | null;
  updatedAt: number;
}

/** What a provisioned kind hands back for one binding's sandbox. Stored
 *  encrypted on the binding; `ref` is the provisioner's own handle for teardown. */
export interface ProvisionedEndpoint {
  transport: HelperTransport;
  privateKey: string;
  ref?: string;
}

export type ParseResult =
  | { ok: true; config: Record<string, string>; secrets?: Record<string, string> }
  | { ok: false; error: string };

/**
 * One environment kind (spec §3.3). A kind only describes how to reach a
 * machine: every kind ends in a {@link ConnectInfo} (an ssh2 transport and a
 * private key), and the tools, the helper process, approvals and the guard are
 * shared by all of them.
 */
export interface EnvironmentKind {
  kind: string;
  /** Human label for the kind picker. */
  label: string;
  /** `user-machine`: a person's own box (locked /1on1, manager filter, cron
   *  guard). `provisioned`: a disposable sandbox slaude creates (spec §4). */
  trust: EnvTrust;
  fields: FieldSpec[];
  /** Validate form input. Never echo values in the error (they may be addresses). */
  parse(input: Record<string, string>): ParseResult;
  /** Private setup steps for the owner. `publicKey` is their slaude key. */
  setupGuide(publicKey: string): string;
  /** user-machine kinds: reach the machine with the owner's key. May consult
   *  the outbound policy (and so be async and throw a user-facing Error). */
  transport?(env: StoredEnv): HelperTransport | Promise<HelperTransport>;
  /** Short health word for /env status ("direct", "relayed", "reachable"…).
   *  Never throws, never includes an address. */
  status(env: StoredEnv, info: ConnectInfo | null): Promise<string>;
  /** provisioned kinds: create the sandbox for one binding. */
  provision?(env: StoredEnv, bindingKey: string): Promise<ProvisionedEndpoint>;
  /** provisioned kinds: destroy it. Best effort, idempotent. */
  teardown?(env: StoredEnv, endpoint: ProvisionedEndpoint, bindingKey: string): Promise<void>;
  /** tailcat only: the address older nodes read from the job token, and the
   *  part that keeps a migrated binding's session fingerprint unchanged. */
  legacyAddr?(env: StoredEnv): string;
  /** Config keys a pre-flight may fill in (ssh: the pinned host key). */
  pinnedKey?: string;
}
