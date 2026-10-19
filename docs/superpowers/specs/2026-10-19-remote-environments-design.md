# Environments — `/remote` as a choice of saved execution environments

**Date:** 2026-10-19
**Status:** Phases 1–2 implemented (environments, `/env`, tailcat and ssh kinds). The provisioned-kind interface, lifecycle and trust rules (§4, §7) are implemented and tested against a fake kind; no real sandbox kind ships until the provisioner decision (§7). See `docs/site/_content/field-notes/2026-10-19-remote-environments.md`.
**Supersedes (when built):** the single tailcat target of `2026-09-29-remote-exec-design.md` §2–§3. Its tool aliasing, guard, approval rules and key custody stay as they are.
**Ships as:** a release candidate (migration + agent-loop change), behind `SLAUDE_REMOTE=1` as today.

## 1. Goal

Today a thread is either *local* (tools run in `$SLAUDE_HOME/workspaces/<thread>`)
or *remote* on one hard-coded transport: tailcat SSH to the initiator's
machine, entered as a raw address + directory.

Make it work like the environment picker in a desktop coding agent: a user
saves **named environments** once and then picks one per thread. tailcat is
the first **kind**. More kinds follow without touching the agent loop: plain
SSH, Docker-in-Docker sandboxes, Firecracker microVMs, and others.

### Decisions taken in the brainstorm

| Question | Decision |
|---|---|
| Who owns an environment | **Personal only.** Every environment belongs to one (workspace, Slack user). No shared/channel environments, no channel defaults. |
| Lock requirement | **Per trust class.** Kinds that reach a person's own machine keep the locked `/1on1` rule; disposable, slaude-provisioned sandboxes do not need it. |
| Where sandboxes run | **Decided later.** This design fixes the kind interface and the lifecycle hooks; the provisioner (external host API vs on the node) is chosen when the first provisioned kind is built. |
| Command | **`/env`**, with `/remote` kept as an alias that keeps working. |

### Non-goals

- Shared or operator-defined environments, channel defaults (see "Personal only").
- More than one environment bound to a thread at a time.
- Running the CLI itself inside the environment. The loop, credentials, KB and
  transcript stay on slaude; only the tools move (unchanged from v1).
- Choosing the sandbox provisioner (deferred, §7).

## 2. Existing seam (why this is mostly plumbing)

The six aliased tools (`bash`, read/write/edit, glob/grep, plus
`bash_output`/`bash_kill`) only ever call one function:

```ts
type Exec = (cmd: string, opts: ExecOpts) => Promise<ExecResult>;
interface RemoteHandle { exec: Exec; release(): Promise<void>; dispose(): Promise<void> }
```

Any backend that can run a POSIX shell command with stdin, a timeout, and
process-group kill can host the tools. `HelperClient` already types its
transport as a union (`tailcat | tcp`). The parts that still assume tailcat
are listed below. They are what this design generalises:

| Where | Today |
|---|---|
| `remote_targets` row | `addr`, `dir` |
| Job token claim `remote` (`gateway/api/auth.ts`) | `{ addr, dir }` |
| `sessionConfigFp` (`remote/fingerprint.ts`) | `[addr, dir]` |
| `remote-command.ts` | `isTailcatAddr`, `tailcatPing`, tailcat setup text |
| `node/remote.ts` | `transport: { kind: "tailcat", addr }` |
| `remote/conn.ts` | `hostVerifier: () => true`. Safe only because the tailcat address pins the WireGuard key. |

## 3. Concepts

### 3.1 Environment

A saved, named config owned by one person.

```ts
interface Environment {
  id: string;                 // opaque, stable
  teamId: string; userId: string;   // owner (personal only)
  name: string;               // unique per owner, e.g. "laptop", "build-box"
  kind: string;               // "tailcat" | "ssh" | "dind" | "firecracker" | ...
  config: unknown;            // kind-specific, validated by the kind; sensitive parts encrypted
  defaultDir: string | null;  // used when a binding gives no dir
  createdAt: number; updatedAt: number;
}
```

Users also have an implicit environment, **`server`** (local, today's
behaviour). `/env off` is shorthand for `/env use server`.

### 3.2 Binding

A thread points at at most one environment:
`(channel, thread) → (envId, dir, lockByEnv)`. This replaces `remote_targets`.
The binder must be the environment's owner.

### 3.3 Kind

Each kind is one module in a registry (`src/remote/kinds/<kind>.ts`):

```ts
interface EnvironmentKind<C> {
  kind: string;
  trust: "user-machine" | "provisioned";
  /** Parse + validate user input (from the modal or command args). Never echoes secrets. */
  parseConfig(input: Record<string, string>): { ok: true; config: C } | { ok: false; error: string };
  /** Modal fields for /env add (Block Kit inputs), and the private setup guide. */
  form(): FieldSpec[];
  setupGuide(ctx: { publicKey: string }): string;
  /** Reachability + resolve the directory to an absolute path (today's preflight). */
  preflight(env: ResolvedEnv, dir: string): Promise<{ ok: true; dir: string } | { ok: false; error: string }>;
  /** Short health line for /env status ("direct", "relayed", "running", "stopped"). */
  status(env: ResolvedEnv): Promise<string>;
  /** Open the exec handle on the machine that runs the session (gateway for mono, node when split). */
  open(env: ResolvedEnv, sessionKey: string): Promise<RemoteHandle>;
  /** provisioned kinds only. */
  provision?(env: ResolvedEnv, sessionKey: string): Promise<ProvisionedEndpoint>;
  teardown?(env: ResolvedEnv, sessionKey: string): Promise<void>;
}
```

`ResolvedEnv` is the environment with secrets decrypted. It exists only in
memory, on the gateway or in the node's helper subprocess. The custody rules
are the same as for today's key.

## 4. Trust classes

| | `user-machine` (tailcat, ssh) | `provisioned` (dind, firecracker) |
|---|---|---|
| Whose machine | The owner's own box or account | A disposable sandbox slaude creates |
| Requires locked `/1on1` to the owner | **Yes** (unchanged) | **No** |
| Manager filter (managers only get `off`/status) | Yes | No: anyone admitted to the thread may use it |
| Foreign-cron guard on bind | Yes | No |
| Who can run `/env off` | Owner or manager | Owner, manager, or (if unlocked) anyone admitted |
| Lifetime | Machine outlives the thread | One sandbox per binding; torn down on unbind or idle |

**Consequence of "personal only" + "unlocked sandboxes".** A sandbox
environment is owned by one person, but once bound to an unlocked thread,
everyone in that thread can steer it. So a `provisioned` kind **must not carry
the owner's personal secrets** into the sandbox (no SSH private key, no
personal tokens). Its config is limited to an image or template, resources,
network policy and a setup script. If a sandbox config ever does need a
secret, binding it requires the locked `/1on1`, the same as `user-machine`.
This rule is enforced in the kind's `parseConfig` and checked in the binder.

## 5. Kinds

| Kind | Phase | Transport | Notes |
|---|---|---|---|
| `tailcat` | 1 | ssh2 over `tailcat <addr> 22` | Today's code moved behind the interface. Uses the per-user ed25519 key. Host verified by the WireGuard key in the address. |
| `ssh` | 2 | ssh2 over TCP (`host`, `port`, `user`) | Reuses the per-user key (or an optional per-environment key). **Host-key pinning required**: trust on first use at `/env add` preflight, show the fingerprint privately, store it, and refuse a mismatch with `REMOTE_HOST_CHANGED`. Outbound target goes through the existing outbound-fetch policy (no loopback/private ranges unless the operator allows them). |
| `dind` | 3 | Provisioner returns an exec endpoint (ssh or a container exec API) | Image, CPU/memory, network on/off, setup script. Provisioner deferred (§7). |
| `firecracker` | 4 | Same as `dind` | microVM template instead of image. |

Every kind must provide the shell contract the tools rely on: `bash`, a
process group per command (`perl setpgrp` today, or `setsid`), and `kill`
by group. `preflight` checks for them.

## 6. Plumbing changes

- **Job token claim.** `remote: { addr, dir }` becomes
  `env: { id, kind, dir, configHash }`. The node fetches the resolved config
  (secrets included) from the gateway, the same way `GET /v1/tenants/:t/remote-key`
  works today, generalised to `GET .../env/:id`. The gateway re-verifies the
  token, checks `runAs` is the owner, and serves only that environment.
  `configHash` covers the non-secret config plus a secret epoch, so a token
  never carries addresses or secrets.
- **Fingerprint.** `[addr, dir]` becomes `[kind, envId, configHash, dir]`.
  Editing an environment, or rotating its key or host pin, reboots warm
  sessions through the existing mechanism. To keep existing fingerprints valid
  during rollout, tailcat bindings hash exactly as before until their row is
  migrated.
- **Node.** `makeRemoteFactory` looks up the kind and calls `kind.open(...)`.
  `HelperClient`'s transport union grows with the kinds that use ssh2.
- **Status line / audit.** Shows the environment *name* and kind, never
  addresses (today's rule, extended).
- **Error codes.** Add `REMOTE_HOST_CHANGED` and `REMOTE_PROVISION_FAILED`.
  "Never fall back to local" stays.

## 7. Provisioned lifecycle (interface now, provisioner later)

- `/env use <sandbox>` calls `provision(env, sessionKey)` from the gateway,
  stores the endpoint on the binding (encrypted), then preflights.
- The endpoint is what `open` connects to on the node. The node never
  provisions, so it stays unprivileged whichever provisioner is chosen.
- `/env off`, `/1on1` transitions that unbind, and an idle TTL call `teardown`,
  best effort and idempotent, as `remoteCleanup` is today.
- Open question for the provisioner decision: an external host API (keeps
  nodes unprivileged, fits "gateway owns credentials") vs on the node
  (lower latency, needs privileged/KVM pods). Also open: whether the workspace
  persists across sandboxes (volume) or is ephemeral.

## 8. Commands and UX

| Command | Effect |
|---|---|
| `/env` | Status: the thread's current environment (name, kind, dir, health) plus a private list of your environments with *Use* buttons and *Add environment*. |
| `/env add` | Private modal: a **kind** dropdown (dispatch action, `views.update`) then that kind's fields, name, and default dir. Runs preflight before saving. Secrets typed here never appear in the thread. |
| `/env use <name> [dir]` | Bind the thread. Applies the trust-class rules in §4 (locks the thread for `user-machine`). |
| `/env off` | Back to `server`. Same unlock and cleanup rules as `/remote off`. |
| `/env edit <name>` / `/env rm <name>` | Edit or delete (deleting unbinds every thread using it). |
| `/env key` | Today's `/remote key`: the per-user public key and setup guide. |
| `/remote …` | Alias. `/remote <addr> [dir]` finds or creates a tailcat environment for that address (auto-named, e.g. `tailcat-1`) and binds it. `/remote off` = `/env off`. |

The panel/portal can list and edit the same environments later. This design
does not require it.

## 9. Data model (migration `00NN_environments.sql`)

```sql
CREATE TABLE environments (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT 'default',
  team_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  config      TEXT NOT NULL,      -- JSON, non-secret fields
  secrets     TEXT,               -- crypto.ts envelope (AES-256-GCM), nullable
  default_dir TEXT,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  UNIQUE (team_id, user_id, name)
);

CREATE TABLE env_bindings (
  tenant_id   TEXT NOT NULL DEFAULT 'default',
  channel_id  TEXT NOT NULL,
  thread_ts   TEXT NOT NULL,
  env_id      TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  dir         TEXT NOT NULL,
  lock_by_env INTEGER NOT NULL DEFAULT 0,
  endpoint    TEXT,               -- provisioned kinds: encrypted endpoint
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (channel_id, thread_ts)
);
```

`remote_keys` stays as the per-user SSH identity. Migration: every
`remote_targets` row becomes a `tailcat` environment (one per distinct
(team, user, addr), named `tailcat-N`) plus a binding with the same dir and
`lock_by_remote`. `remote_targets` is dropped one release later.

## 10. Phases

1. **Refactor, no behaviour change.** Add the kind registry, move tailcat
   behind it, add the tables, migration and fingerprint compatibility, and
   `/env` list/use/off/add with tailcat as the only kind. `/remote` aliases it.
   Ships as an RC.
2. **`ssh` kind.** Host-key pinning, outbound policy, setup guide.
3. **First `provisioned` kind (`dind`).** Decide the provisioner first (§7),
   then add provision/teardown/idle TTL and the unlocked-thread rules.
4. **`firecracker`.**

## 11. Tests

- Kind contract test suite run against every kind (fake transport for
  provisioned kinds): exec, timeout + group kill, drop mid-command, preflight.
- Handler tests per trust class: lock required or not, manager filter,
  foreign-cron guard, who may `/env off`.
- Fingerprint: a migrated tailcat binding keeps its old fingerprint; editing an
  environment changes it; the node reboots on change.
- Key/env endpoint: refuses a token whose `runAs` is not the owner, and never
  serves another user's environment.
- ssh: host-key mismatch is refused and reported, never auto-accepted.

## 12. Open questions

- Should the per-user key stay one key for all `user-machine` environments, or
  should each environment get its own (simpler revocation vs. more setup)?
- Should `/env use` with no name offer the user's last-used environment?
- Should a thread remember its previous environment across `/env off` so
  `/env on` can resume it?
- For `provisioned`: does the agent's `server` workspace get copied in, or does
  the setup script clone the repo itself?
