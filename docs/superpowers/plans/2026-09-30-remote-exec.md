# `/remote` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a thread's initiator type `/remote <tailcat-addr> <dir>` so the agent's Bash/Read/Write/Edit/Glob/Grep run on their own machine over tailcat SSH, and `/remote off` switches back, without losing the conversation.

**Architecture:** The agent loop stays on slaude. When a thread has an active remote target, the session boots with an in-process `remote` MCP server whose tools run over one SSH connection (held by a helper subprocess, socket = `tailcat <addr> 22`), `toolAliases` routing the six built-in names to it, and a `PreToolUse` guard that denies any call reaching a local built-in. Mode changes reboot the session (`agent.reload`); on nodes a signed `sessionConfigFp` claim triggers the reboot.

**Tech Stack:** Bun + TypeScript, `@anthropic-ai/claude-agent-sdk` 0.3.173 (`toolAliases`, `createSdkMcpServer`, `tool`), `ssh2` ^1.17 (client, test server, `utils.generateKeyPairSync`), zod 3, tailcat v0.7.0.

**Spec:** `docs/superpowers/specs/2026-09-29-remote-exec-design.md`

## Global Constraints

- Feature flag: `SLAUDE_REMOTE` (`1`/`true`/`yes` = on), **off by default**. With it off, `/remote` replies that it is disabled and nothing else changes.
- Ships as a release candidate `vX.Y.Z-rc.N` (new migration + agent-loop change).
- Remote always implies the `/1on1` lock, **locked** (not open). Invariant: no locked lock owned by the target's user ⇒ no remote.
- Remote mode never falls back to local tools.
- The private key is never logged, never written to disk outside the encrypted DB column, never put in env; on nodes it lives only in the helper subprocess's memory.
- The tailcat address is never echoed in thread replies, status lines, logs or audit lines.
- Every path/argument interpolated into a remote command goes through `shq()`.
- Tool input schemas mirror the built-ins' field names exactly (`command`, `timeout`, `description`, `run_in_background`, `file_path`, `offset`, `limit`, `content`, `old_string`, `new_string`, `replace_all`, `pattern`, `path`, `glob`, `type`, `output_mode`, `-i`, `-n`, `-A`, `-B`, `-C`, `head_limit`, `multiline`).
- Latency budget: warm exec overhead p50 < 150 ms on a direct path.
- Public repo: no real names, org names, internal channels or deployment identifiers in code, tests, comments or commits. Run the CLAUDE.md leak-scan grep on every staged diff before committing. No AI co-author trailers.
- Tests live under `tests/` mirroring `src/`; run with `bun test <path>`.
- Tests that use `bash -l` (Task 2 `wrapCommand` login test, Task 6 bash tests) assume the developer's login profile prints nothing to stdout; if one fails locally with extra output, check `~/.bash_profile` before touching the code. CI is clean.
- The helper is spawned from source (`src/remote/helper-main.ts` next to `helper-client.ts`). Both the Docker image (`COPY src`) and the release tarball ship `src/`; keep it that way — a bundling step would need to emit the helper entry too.

## Review Focus

1. **Paths with spaces, quotes, `$`, or leading `-`** in `file_path`, `dir`, `pattern`, and commands — expected: handled literally, never shell-interpreted. Pinned in Task 2 (`shq` table) and Task 5 (read/write a file named `a b'$(x).txt`).
2. **The user edits a file between the agent's Read and Edit/Write** — expected: the edit is refused with "modified since read", not a silent overwrite. Pinned in Task 5.
3. **The laptop goes to sleep mid-turn** (connection dies) — expected: between commands, one reconnect then `REMOTE_UNREACHABLE`; *during* a command, `REMOTE_UNREACHABLE` immediately with no automatic re-run; the node does not crash; the next call after wake reconnects. Pinned in Task 3 (server killed between and during commands, then restarted).
4. **A long-running foreground command exceeds its timeout** — expected: the whole process group is killed on the remote (no orphan), partial output returned with a timeout note. Pinned in Task 3.
5. **A manager (not the lock owner) types `/remote <addr> <dir>`, or someone runs `/1on1 open` while remote is on** — expected: the manager cannot point the thread at their own machine under someone else's lock; opening the 1on1 ends remote mode. Pinned in Task 9 and Task 10.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/migrations/0009_remote.sql` (new) | Postgres tables `remote_targets`, `remote_keys` |
| `src/db/drivers/sqlite.ts` (modify) | sqlite mirror of both tables |
| `src/db/remote.ts` (new) | Repo: targets (per thread) + keys (per team/user, private key encrypted) |
| `src/config/env.ts` (modify) | `env.remote.enabled()` |
| `src/remote/types.ts` (new) | `Exec`, `ExecOpts`, `ExecResult`, `RemoteError`, `RemoteTarget`, `RemoteHandle` |
| `src/remote/shell.ts` (new) | `shq`, `wrapCommand`, `MTIME`, validators |
| `src/remote/fingerprint.ts` (new) | `sessionConfigFp` |
| `src/remote/conn.ts` (new) | `RemoteConn`: ssh2 client, exec, pgid kill, truncation, reconnect, idle |
| `src/remote/tailcat.ts` (new) | `tailcatSocket(addr)`, `tailcatPing(addr)` |
| `src/remote/helper-main.ts` (new) | Helper subprocess entry (JSON lines on stdio) |
| `src/remote/helper-client.ts` (new) | `HelperClient implements RemoteHandle` |
| `src/remote/tools/files.ts` (new) | read / write / edit + `ReadState` |
| `src/remote/tools/search.ts` (new) | glob / grep |
| `src/remote/tools/bash.ts` (new) | bash (fg + background), bash_output, bash_kill, cleanup |
| `src/remote/mcp.ts` (new) | `createRemoteMcp`, aliases, guard hook, permission mapping, audit |
| `src/remote/active.ts` (new) | `activeRemoteTarget(channel, thread)` — lock + target consistency |
| `src/remote/preflight.ts` (new) | `preflight({addr, dir, privateKey})` |
| `src/agent/session-mode.ts` (modify) | remote block |
| `src/agent/manager.ts` (modify) | `setRemote`, options wiring, `ensureConfigFp`, disposal, live mode |
| `src/gateway/slack/commands.ts` (modify) | `/remote` parse + help |
| `src/gateway/core/remote-command.ts` (new) | `/remote` handler logic + `endRemoteForThread` |
| `src/gateway/core/gateway.ts` (modify) | dispatch `/remote`, `/1on1` invariants, mono wiring, status marker |
| `src/gateway/core/status-text.ts` (modify) | optional `remote` marker |
| `src/gateway/api/auth.ts` (modify) | `JobClaims.remote`, `JobClaims.sessionConfigFp` |
| `src/gateway/core/dispatch.ts` (modify) | mint the two claims |
| `src/gateway/api/remote-key.ts` (new) + `src/gateway/api/index.ts` (modify) | key endpoint |
| `src/node/client.ts`, `src/node/worker.ts` (modify) | fetch key, remote resolver from claims, fp reload |
| `Dockerfile` (modify) | install tailcat 0.7.0 |
| docs (new/modify) | field note, guide page, CLAUDE.md index |

---

### Task 1: Flag, dependency, and storage

**Files:**
- Modify: `package.json` (add `ssh2`, `@types/ssh2`)
- Modify: `src/config/env.ts` (add `remote` block next to `portal`)
- Create: `src/db/migrations/0009_remote.sql`
- Modify: `src/db/drivers/sqlite.ts` (append to `SCHEMA`)
- Create: `src/db/remote.ts`
- Modify: `tests/setup.ts` (wipe list)
- Test: `tests/db/remote.test.ts`

**Interfaces:**
- Produces:
  - `env.remote.enabled(): boolean`
  - `RemoteTargetRow { channel_id; thread_ts; team_id; user_id; addr; dir; lock_by_remote: number; created_at: number }`
  - `setTarget(i: { channelId; threadTs; teamId; userId; addr; dir; lockByRemote: boolean }): Promise<void>`
  - `findTarget(channelId, threadTs): Promise<RemoteTargetRow | null>`
  - `clearTarget(channelId, threadTs): Promise<RemoteTargetRow | null>` (returns the removed row)
  - `getKey(teamId, userId): Promise<{ privateKey: string; publicKey: string } | null>`
  - `putKeyIfAbsent(teamId, userId, pair): Promise<{ privateKey: string; publicKey: string }>` (returns what is stored)
  - `_wipeForTests(): Promise<void>`

- [ ] **Step 1: Add dependencies**

Run: `bun add ssh2@^1.17.0 && bun add -d @types/ssh2`
Expected: `package.json` gains `"ssh2"` in dependencies and `"@types/ssh2"` in devDependencies; `bun.lock` updates.

- [ ] **Step 2: Write the failing test**

`tests/db/remote.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "bun:test";
import * as Remote from "../../src/db/remote";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
  __resetMasterKeyCache();
  await Remote._wipeForTests();
});

describe("remote_targets", () => {
  it("set then find returns the row; set again replaces it", async () => {
    await Remote.setTarget({ channelId: "C1", threadTs: "1.0", teamId: "T1", userId: "U_A", addr: "tcAAA", dir: "/home/a/repo", lockByRemote: true });
    let row = await Remote.findTarget("C1", "1.0");
    expect(row?.user_id).toBe("U_A");
    expect(row?.dir).toBe("/home/a/repo");
    expect(row?.lock_by_remote).toBe(1);
    await Remote.setTarget({ channelId: "C1", threadTs: "1.0", teamId: "T1", userId: "U_A", addr: "tcBBB", dir: "/home/a/repo", lockByRemote: false });
    row = await Remote.findTarget("C1", "1.0");
    expect(row?.addr).toBe("tcBBB");
    expect(row?.lock_by_remote).toBe(0);
  });

  it("clear returns the removed row and leaves nothing", async () => {
    await Remote.setTarget({ channelId: "C1", threadTs: "1.0", teamId: "T1", userId: "U_A", addr: "tcAAA", dir: "/r", lockByRemote: true });
    const gone = await Remote.clearTarget("C1", "1.0");
    expect(gone?.lock_by_remote).toBe(1);
    expect(await Remote.findTarget("C1", "1.0")).toBeNull();
    expect(await Remote.clearTarget("C1", "1.0")).toBeNull();
  });
});

describe("remote_keys", () => {
  it("putKeyIfAbsent stores once and returns the first pair on later calls", async () => {
    const first = await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV-1", publicKey: "ssh-ed25519 AAA1" });
    const second = await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV-2", publicKey: "ssh-ed25519 AAA2" });
    expect(first.privateKey).toBe("PRIV-1");
    expect(second.privateKey).toBe("PRIV-1");
    expect((await Remote.getKey("T1", "U_A"))?.publicKey).toBe("ssh-ed25519 AAA1");
    expect(await Remote.getKey("T1", "U_B")).toBeNull();
  });

  it("stores the private key encrypted, never in plaintext", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV-SECRET", publicKey: "ssh-ed25519 AAA1" });
    const raw = await db.one<{ private_key: string }>("SELECT private_key FROM remote_keys WHERE team_id = ? AND user_id = ?", ["T1", "U_A"]);
    expect(raw?.private_key).not.toContain("PRIV-SECRET");
    expect(raw?.private_key.startsWith("v1:")).toBe(true);
  });
});

describe("env.remote.enabled", () => {
  it("is off by default and on for 1/true/yes", async () => {
    const { env } = await import("../../src/config/env");
    delete process.env.SLAUDE_REMOTE;
    expect(env.remote.enabled()).toBe(false);
    for (const v of ["1", "true", "YES"]) {
      process.env.SLAUDE_REMOTE = v;
      expect(env.remote.enabled()).toBe(true);
    }
    delete process.env.SLAUDE_REMOTE;
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/db/remote.test.ts`
Expected: FAIL — `Cannot find module '../../src/db/remote'`.

- [ ] **Step 4: Add the flag**

In `src/config/env.ts`, directly after the `portal: { ... },` block:

```ts
  remote: {
    /** `/remote` — run a thread's shell and file tools on the initiator's own
     *  machine over tailcat SSH. Default off; ships behind this flag. */
    enabled: () => {
      const raw = opt("SLAUDE_REMOTE", "0").toLowerCase();
      return raw === "1" || raw === "true" || raw === "yes";
    },
  },
```

- [ ] **Step 5: Postgres migration**

`src/db/migrations/0009_remote.sql`:

```sql
-- /remote: per-thread remote execution target and per-person SSH keys.
-- See docs/superpowers/specs/2026-09-29-remote-exec-design.md §3.
CREATE TABLE IF NOT EXISTS remote_targets (
  tenant_id      TEXT    NOT NULL DEFAULT 'default',
  channel_id     TEXT    NOT NULL,
  thread_ts      TEXT    NOT NULL,
  team_id        TEXT    NOT NULL,
  user_id        TEXT    NOT NULL,
  addr           TEXT    NOT NULL,
  dir            TEXT    NOT NULL,
  lock_by_remote INTEGER NOT NULL DEFAULT 0,
  created_at     BIGINT  NOT NULL,
  PRIMARY KEY (channel_id, thread_ts)
);

-- private_key holds a src/db/crypto.ts envelope (AES-256-GCM), never plaintext.
CREATE TABLE IF NOT EXISTS remote_keys (
  team_id     TEXT   NOT NULL,
  user_id     TEXT   NOT NULL,
  public_key  TEXT   NOT NULL,
  private_key TEXT   NOT NULL,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
```

- [ ] **Step 6: sqlite mirror**

In `src/db/drivers/sqlite.ts`, append to the `SCHEMA` template string (after the `one_on_one_locks` table, keeping the `;` separators):

```sql
CREATE TABLE IF NOT EXISTS remote_targets (
  channel_id     TEXT    NOT NULL,
  thread_ts      TEXT    NOT NULL,
  team_id        TEXT    NOT NULL,
  user_id        TEXT    NOT NULL,
  addr           TEXT    NOT NULL,
  dir            TEXT    NOT NULL,
  lock_by_remote INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (channel_id, thread_ts)
);
CREATE TABLE IF NOT EXISTS remote_keys (
  team_id     TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  public_key  TEXT    NOT NULL,
  private_key TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
```

- [ ] **Step 7: Repo module**

`src/db/remote.ts`:

```ts
import { db } from "./schema";
import { encrypt, decrypt } from "./crypto";

export interface RemoteTargetRow {
  channel_id: string;
  thread_ts: string;
  team_id: string;
  user_id: string;
  /** tailcat address. Sensitive: never echo, never log. */
  addr: string;
  /** Absolute directory on the remote, resolved at pre-flight. */
  dir: string;
  /** 1 when `/remote` created the thread's 1on1 lock (so `/remote off` releases it). */
  lock_by_remote: number;
  created_at: number;
}

export interface RemoteKeyPair {
  privateKey: string;
  publicKey: string;
}

export async function setTarget(i: {
  channelId: string; threadTs: string; teamId: string; userId: string;
  addr: string; dir: string; lockByRemote: boolean;
}): Promise<void> {
  await db.run(
    `INSERT INTO remote_targets (channel_id, thread_ts, team_id, user_id, addr, dir, lock_by_remote, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, thread_ts)
     DO UPDATE SET team_id = excluded.team_id, user_id = excluded.user_id, addr = excluded.addr,
                   dir = excluded.dir, lock_by_remote = excluded.lock_by_remote, created_at = excluded.created_at`,
    [i.channelId, i.threadTs, i.teamId, i.userId, i.addr, i.dir, i.lockByRemote ? 1 : 0, Date.now()],
  );
}

export async function findTarget(channelId: string, threadTs: string): Promise<RemoteTargetRow | null> {
  return db.one<RemoteTargetRow>(
    "SELECT * FROM remote_targets WHERE channel_id = ? AND thread_ts = ?",
    [channelId, threadTs],
  );
}

/** Remove a thread's target. Returns the removed row (null when there was none). */
export async function clearTarget(channelId: string, threadTs: string): Promise<RemoteTargetRow | null> {
  const row = await findTarget(channelId, threadTs);
  if (!row) return null;
  await db.run("DELETE FROM remote_targets WHERE channel_id = ? AND thread_ts = ?", [channelId, threadTs]);
  return row;
}

export async function getKey(teamId: string, userId: string): Promise<RemoteKeyPair | null> {
  const row = await db.one<{ public_key: string; private_key: string }>(
    "SELECT public_key, private_key FROM remote_keys WHERE team_id = ? AND user_id = ?",
    [teamId, userId],
  );
  if (!row) return null;
  return { publicKey: row.public_key, privateKey: decrypt(row.private_key) };
}

/** Store a pair unless one exists; always returns the stored pair (first writer wins). */
export async function putKeyIfAbsent(teamId: string, userId: string, pair: RemoteKeyPair): Promise<RemoteKeyPair> {
  await db.run(
    `INSERT INTO remote_keys (team_id, user_id, public_key, private_key, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(team_id, user_id) DO NOTHING`,
    [teamId, userId, pair.publicKey, encrypt(pair.privateKey), Date.now()],
  );
  const stored = await getKey(teamId, userId);
  if (!stored) throw new Error("remote key insert did not persist");
  return stored;
}

export async function _wipeForTests(): Promise<void> {
  await db.run("DELETE FROM remote_targets");
  await db.run("DELETE FROM remote_keys");
}
```

- [ ] **Step 8: Test-DB wipe list**

In `tests/setup.ts`, add `"remote_targets"` and `"remote_keys"` to the pg wipe array right after `"one_on_one_locks"`.

- [ ] **Step 9: Run tests**

Run: `bun test tests/db/remote.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 10: Commit**

```bash
git add package.json bun.lock src/config/env.ts src/db/migrations/0009_remote.sql src/db/drivers/sqlite.ts src/db/remote.ts tests/setup.ts tests/db/remote.test.ts
git commit -m "feat(remote): SLAUDE_REMOTE flag and remote_targets/remote_keys storage"
```

---

### Task 2: Shell quoting, command wrapping, fingerprint

**Files:**
- Create: `src/remote/types.ts`, `src/remote/shell.ts`, `src/remote/fingerprint.ts`
- Test: `tests/remote/shell.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export type RemoteErrorCode = "REMOTE_UNREACHABLE" | "REMOTE_AUTH_FAILED";
  export class RemoteError extends Error { readonly code: RemoteErrorCode; readonly started: boolean }
  export interface ExecOpts { stdin?: string; timeoutMs: number; login?: boolean; maxOutput?: number }
  export interface ExecResult { stdout: string; stderr: string; code: number | null; truncated: boolean; timedOut: boolean }
  export type Exec = (cmd: string, opts: ExecOpts) => Promise<ExecResult>;
  export interface RemoteTarget { teamId: string; userId: string; addr: string; dir: string }
  export interface RemoteHandle { exec: Exec; release(): Promise<void>; dispose(): Promise<void> }
  ```
- Produces (`shell.ts`): `shq(s)`, `PGRP_MARKER = "__SLAUDE_PGID__"`, `wrapCommand(cmd, login)`, `MTIME`, `isTailcatAddr(s)`, `isRemoteDir(s)`, `sanitizeKey(s)`
- Produces (`fingerprint.ts`): `sessionConfigFp(lockUser: string | null, remote: { addr: string; dir: string } | null): string`

- [ ] **Step 1: Write the failing test**

`tests/remote/shell.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { shq, wrapCommand, isTailcatAddr, isRemoteDir, sanitizeKey, PGRP_MARKER } from "../../src/remote/shell";
import { sessionConfigFp } from "../../src/remote/fingerprint";

const sh = (cmd: string) => spawnSync("/bin/sh", ["-c", cmd], { encoding: "utf8" });

describe("shq", () => {
  for (const s of ["plain", "a b", "it's", "$(touch /tmp/x)", "`id`", "-rf", "semi;colon", "new\nline", "back\\slash", ""]) {
    it(`round-trips ${JSON.stringify(s)} literally`, () => {
      expect(sh(`printf %s ${shq(s)}`).stdout).toBe(s);
    });
  }
});

describe("wrapCommand", () => {
  it("runs the command in its own process group and prints the pgid marker on stderr", () => {
    const r = sh(wrapCommand("echo hi; echo err >&2", false));
    expect(r.stdout).toBe("hi\n");
    const m = r.stderr.match(new RegExp(`${PGRP_MARKER}(\\d+)`));
    expect(m).not.toBeNull();
    expect(r.stderr).toContain("err");
  });
  it("preserves the exit code", () => {
    expect(sh(wrapCommand("exit 7", false)).status).toBe(7);
  });
  it("login=true runs under bash -l", () => {
    expect(sh(wrapCommand("shopt -q login_shell && echo login", true)).stdout).toBe("login\n");
  });
});

describe("validators", () => {
  it("isTailcatAddr accepts addresses and DNS names, rejects flags and shell chars", () => {
    expect(isTailcatAddr("tcpGFwWCCEqTunZO94axBVxJ5xMNnoCc87SsBBqLUbCwCSZq_4N2Fr")).toBe(true);
    expect(isTailcatAddr("dev.example.com")).toBe(true);
    for (const bad of ["-o", "--serve", "a b", "x;y", "$(id)", "", "ab"]) expect(isTailcatAddr(bad)).toBe(false);
  });
  it("isRemoteDir accepts absolute and ~/ paths only", () => {
    expect(isRemoteDir("/home/a/repo")).toBe(true);
    expect(isRemoteDir("~/code/repo")).toBe(true);
    expect(isRemoteDir("~")).toBe(true);
    for (const bad of ["repo", "./repo", "/a\nb", "/a\0b", ""]) expect(isRemoteDir(bad)).toBe(false);
  });
  it("sanitizeKey keeps only [A-Za-z0-9_-]", () => {
    expect(sanitizeKey("abc-123_X/../y z")).toBe("abc-123_Xyz");
    expect(sanitizeKey("ok_id-1")).toBe("ok_id-1");
    expect(sanitizeKey("../../etc")).toBe("etc");
  });
});

describe("sessionConfigFp", () => {
  it("is stable for equal input and changes with lock owner or target", () => {
    const a = sessionConfigFp("U1", { addr: "tcA", dir: "/r" });
    expect(sessionConfigFp("U1", { addr: "tcA", dir: "/r" })).toBe(a);
    expect(sessionConfigFp("U2", { addr: "tcA", dir: "/r" })).not.toBe(a);
    expect(sessionConfigFp("U1", { addr: "tcB", dir: "/r" })).not.toBe(a);
    expect(sessionConfigFp("U1", { addr: "tcA", dir: "/s" })).not.toBe(a);
    expect(sessionConfigFp("U1", null)).not.toBe(a);
    expect(sessionConfigFp(null, null)).toMatch(/^[0-9a-f]{16}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/remote/shell.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/remote/types.ts`:

```ts
export type RemoteErrorCode = "REMOTE_UNREACHABLE" | "REMOTE_AUTH_FAILED";

/** Transport-level failure. Tool-level failures (non-zero exit, missing file)
 *  are ordinary ExecResults, not RemoteErrors. `started` = the command may
 *  already have run on the remote, so it must not be retried automatically. */
export class RemoteError extends Error {
  constructor(readonly code: RemoteErrorCode, message: string, readonly started = false) {
    super(`${code}: ${message}`);
    this.name = "RemoteError";
  }
}

export interface ExecOpts {
  stdin?: string;
  timeoutMs: number;
  /** Run under `bash -lc` (user's PATH/profile). Only the bash tool sets this. */
  login?: boolean;
  /** Head size kept before truncating stdout (default 30_000 chars). */
  maxOutput?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  truncated: boolean;
  timedOut: boolean;
}

export type Exec = (cmd: string, opts: ExecOpts) => Promise<ExecResult>;

export interface RemoteTarget {
  teamId: string;
  userId: string;
  addr: string;
  dir: string;
}

export interface RemoteHandle {
  exec: Exec;
  /** Release the connection only (session reboot / idle). Background jobs keep
   *  running; a later exec reconnects lazily. */
  release(): Promise<void>;
  /** Remote mode ended for this session: kill its background jobs, then release. */
  dispose(): Promise<void>;
}
```

`src/remote/shell.ts`:

```ts
/** POSIX single-quote a string so the remote shell passes it through literally. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const PGRP_MARKER = "__SLAUDE_PGID__";

/** perl is present on stock macOS and Debian/Ubuntu; macOS has no `setsid`.
 *  setpgrp gives the command its own process group (pid == pgid) so a timeout
 *  or kill can take down everything it spawned; the marker tells the caller
 *  which group that is. `exec` keeps the pid. */
const PGRP = String.raw`perl -e 'setpgrp(0,0); print STDERR "${PGRP_MARKER}$$\n"; exec @ARGV'`;

/** Wrap a command for the remote. tailcat's SSH server runs `$SHELL -c <string>`
 *  (non-login, often zsh); we normalise to /bin/sh, or bash -l for the bash tool. */
export function wrapCommand(cmd: string, login: boolean): string {
  return `${PGRP} ${login ? "bash -lc" : "/bin/sh -c"} ${shq(cmd)}`;
}

/** Shell snippet printing a path's mtime (sub-second) — `$1`-style use: `${MTIME} <quoted path>`. */
export const MTIME = String.raw`perl -MTime::HiRes=stat -e 'my @s = stat shift; print defined $s[9] ? $s[9] : ""'`;

/** A tailcat address or a DNS name carrying one. Never starts with '-' (flag injection). */
export function isTailcatAddr(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,511}$/.test(s);
}

/** Absolute or home-relative, no control characters. */
export function isRemoteDir(s: string): boolean {
  if (!s || /[\0\n\r]/.test(s)) return false;
  return s === "~" || s.startsWith("~/") || s.startsWith("/");
}

/** File-name-safe key (session ids into remote paths). */
export function sanitizeKey(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "");
}
```

`src/remote/fingerprint.ts`:

```ts
import { createHash } from "node:crypto";

/** Identifies the session config a turn expects: who the thread is locked to and
 *  where tools run. Signed into the job token; a node reboots a warm session
 *  when it changes (spec §4.4). */
export function sessionConfigFp(lockUser: string | null, remote: { addr: string; dir: string } | null): string {
  return createHash("sha256")
    .update(JSON.stringify([lockUser, remote ? [remote.addr, remote.dir] : null]))
    .digest("hex")
    .slice(0, 16);
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/remote/shell.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/remote/types.ts src/remote/shell.ts src/remote/fingerprint.ts tests/remote/shell.test.ts
git commit -m "feat(remote): shell quoting, process-group wrapper, config fingerprint"
```

---

### Task 3: `RemoteConn` — exec over ssh2, plus the tailcat socket

**Files:**
- Create: `src/remote/conn.ts`, `src/remote/tailcat.ts`
- Create: `tests/remote/ssh-test-server.ts` (test helper)
- Test: `tests/remote/conn.test.ts`

**Interfaces:**
- Consumes: `types.ts`, `shell.ts` (Task 2)
- Produces:
  - `type SocketFactory = () => Duplex | Promise<Duplex>`
  - `class RemoteConn { constructor(o: ConnOpts); exec: Exec; close(): void }`
  - `interface ConnOpts { socket: SocketFactory; privateKey: string; username?: string; idleMs?: number; readyTimeoutMs?: number; reconnectDelayMs?: number }`
  - `capOutput(chunks, head, tail)` internal
  - `tailcatSocket(addr: string, bin?: string): SocketFactory`
  - `tailcatPing(addr: string, bin?: string): Promise<"direct" | "relayed" | "unreachable">`
  - Test helper: `startTestSshServer(opts: { authorizedPublicKey: string }): Promise<{ port: number; stop(): Promise<void> }>`

- [ ] **Step 1: Test SSH server helper**

`tests/remote/ssh-test-server.ts` — hermetic in-process SSH server executing commands locally (like tailcat's: runs the command string through a shell):

```ts
import { Server, utils } from "ssh2";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";

export async function startTestSshServer(opts: { authorizedPublicKey: string }) {
  const parsed = utils.parseKey(opts.authorizedPublicKey);
  if (parsed instanceof Error) throw parsed;
  const allowed = Array.isArray(parsed) ? parsed[0]! : parsed;
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  const clients = new Set<any>();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client
      .on("authentication", (ctx) => {
        if (
          ctx.method === "publickey" &&
          ctx.key.algo === allowed.type &&
          timingSafeEqual(ctx.key.data, allowed.getPublicSSH()) &&
          (!ctx.signature || allowed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true)
        ) return ctx.accept();
        ctx.reject();
      })
      .on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("exec", (acceptExec, _reject, info) => {
            const ch = acceptExec();
            const p = spawn("/bin/sh", ["-c", info.command], { stdio: ["pipe", "pipe", "pipe"] });
            p.stdout.pipe(ch, { end: false });
            p.stderr.pipe(ch.stderr, { end: false });
            ch.pipe(p.stdin);
            p.on("close", (code) => {
              ch.exit(code ?? 255);
              ch.end();
            });
            // Channel closed by the client without a pty: like a real sshd, the
            // process is NOT killed here — that is what the pgid kill is for.
          });
        });
      })
      .on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    // net.Server.close waits for open connections; end them so "laptop went away" is immediate.
    stop: () => new Promise<void>((r) => {
      for (const c of clients) c.end();
      server.close(() => r());
    }),
  };
}
```

- [ ] **Step 2: Write the failing test**

`tests/remote/conn.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { connect } from "node:net";
import { spawnSync } from "node:child_process";
import { utils } from "ssh2";
import { RemoteConn } from "../../src/remote/conn";
import { RemoteError } from "../../src/remote/types";
import { startTestSshServer } from "./ssh-test-server";

const pair = utils.generateKeyPairSync("ed25519");
const stranger = utils.generateKeyPairSync("ed25519");
let srv: Awaited<ReturnType<typeof startTestSshServer>>;

const mk = (privateKey = pair.private, port = () => srv.port) =>
  new RemoteConn({ socket: () => connect(port(), "127.0.0.1"), privateKey, reconnectDelayMs: 10, readyTimeoutMs: 3000 });

beforeAll(async () => { srv = await startTestSshServer({ authorizedPublicKey: pair.public }); });
afterAll(async () => { await srv.stop(); });

describe("RemoteConn", () => {
  it("runs a command and returns stdout, stderr (marker stripped) and exit code", async () => {
    const c = mk();
    const r = await c.exec("echo out; echo err >&2; exit 3", { timeoutMs: 5000 });
    expect(r.stdout).toBe("out\n");
    expect(r.stderr).toBe("err\n");
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
    c.close();
  });

  it("feeds stdin", async () => {
    const c = mk();
    const r = await c.exec("cat", { stdin: "hello\nworld", timeoutMs: 5000 });
    expect(r.stdout).toBe("hello\nworld");
    c.close();
  });

  it("runs parallel execs over one connection", async () => {
    const c = mk();
    const t = performance.now();
    await Promise.all(Array.from({ length: 5 }, () => c.exec("sleep 0.3", { timeoutMs: 5000 })));
    expect(performance.now() - t).toBeLessThan(1200);
    c.close();
  });

  it("truncates huge output keeping head and tail", async () => {
    const c = mk();
    const r = await c.exec("i=0; while [ $i -lt 20000 ]; do echo line$i; i=$((i+1)); done", { timeoutMs: 10000, maxOutput: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.startsWith("line0\n")).toBe(true);
    expect(r.stdout).toContain("line19999");
    expect(r.stdout).toContain("[truncated");
    expect(r.stdout.length).toBeLessThan(6000);
    c.close();
  });

  it("on timeout kills the whole process group (no orphan) and marks timedOut", async () => {
    const c = mk();
    const tag = `slaude-orphan-${process.pid}-${Date.now()}`;
    const r = await c.exec(`sh -c 'sleep 30; echo ${tag}' & sleep 30`, { timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    await Bun.sleep(1500);
    const left = spawnSync("/bin/sh", ["-c", `ps -A -o command= | grep -v grep | grep -c 'sleep 30; echo ${tag}' || true`], { encoding: "utf8" });
    expect(left.stdout.trim()).toBe("0");
    c.close();
  });

  it("classifies a rejected key as REMOTE_AUTH_FAILED", async () => {
    const c = mk(stranger.private);
    await expect(c.exec("true", { timeoutMs: 5000 })).rejects.toMatchObject({ code: "REMOTE_AUTH_FAILED" });
    c.close();
  });

  it("classifies a dead endpoint as REMOTE_UNREACHABLE after one retry", async () => {
    const c = mk(pair.private, () => 1); // nothing listens on port 1
    const err = await c.exec("true", { timeoutMs: 5000 }).catch((e) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect(err.code).toBe("REMOTE_UNREACHABLE");
    c.close();
  });

  it("a drop DURING a command is REMOTE_UNREACHABLE and the command is not re-run", async () => {
    let port = srv.port;
    const c = mk(pair.private, () => port);
    const marker = `/tmp/slaude-conn-${process.pid}-${Date.now()}`;
    const running = c.exec(`echo ran >> ${marker}; sleep 5`, { timeoutMs: 10_000 });
    await Bun.sleep(500);
    await srv.stop();
    const err = await running.catch((e) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect(err.code).toBe("REMOTE_UNREACHABLE");
    expect(err.started).toBe(true);
    srv = await startTestSshServer({ authorizedPublicKey: pair.public });
    port = srv.port;
    await Bun.sleep(5000);
    expect((await Bun.file(marker).text()).trim().split("\n")).toEqual(["ran"]);
    c.close();
  });

  it("reconnects after the server restarts (laptop slept and woke)", async () => {
    let port = srv.port;
    const c = mk(pair.private, () => port);
    expect((await c.exec("echo 1", { timeoutMs: 5000 })).stdout).toBe("1\n");
    await srv.stop();
    await expect(c.exec("echo 2", { timeoutMs: 3000 })).rejects.toMatchObject({ code: "REMOTE_UNREACHABLE" });
    srv = await startTestSshServer({ authorizedPublicKey: pair.public });
    port = srv.port;
    expect((await c.exec("echo 3", { timeoutMs: 5000 })).stdout).toBe("3\n");
    c.close();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/remote/conn.test.ts`
Expected: FAIL — module `src/remote/conn` not found.

- [ ] **Step 4: Implement `conn.ts`**

```ts
import { Client, type ClientChannel } from "ssh2";
import type { Duplex } from "node:stream";
import { PGRP_MARKER, wrapCommand } from "./shell";
import { RemoteError, type ExecOpts, type ExecResult } from "./types";

export type SocketFactory = () => Duplex | Promise<Duplex>;

export interface ConnOpts {
  socket: SocketFactory;
  privateKey: string;
  /** tailcat's server authenticates by key and runs as its own user; the name is informational. */
  username?: string;
  idleMs?: number;
  readyTimeoutMs?: number;
  reconnectDelayMs?: number;
}

const DEFAULT_HEAD = 30_000;
const TAIL = 4_000;
const KILL_GRACE_S = 5;

/** Collects a stream keeping the first `head` chars and the last TAIL chars. */
class Capped {
  #head = "";
  #tail = "";
  #dropped = 0;
  constructor(private head: number) {}
  push(s: string) {
    if (this.#head.length < this.head) {
      const room = this.head - this.#head.length;
      this.#head += s.slice(0, room);
      s = s.slice(room);
    }
    if (!s) return;
    this.#tail += s;
    if (this.#tail.length > TAIL) {
      this.#dropped += this.#tail.length - TAIL;
      this.#tail = this.#tail.slice(-TAIL);
    }
  }
  get truncated() { return this.#dropped > 0; }
  text(): string {
    return this.#dropped > 0
      ? `${this.#head}\n[truncated ${this.#dropped} chars]\n${this.#tail}`
      : this.#head + this.#tail;
  }
}

export class RemoteConn {
  #client: Client | null = null;
  #connecting: Promise<Client> | null = null;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #active = 0;

  constructor(private o: ConnOpts) {}

  exec = async (cmd: string, opts: ExecOpts): Promise<ExecResult> => {
    try {
      return await this.#run(cmd, opts);
    } catch (e) {
      // Retry only failures before the command could have started: re-running a
      // half-executed, non-idempotent command is worse than reporting the drop.
      if (!(e instanceof RemoteError) || e.code !== "REMOTE_UNREACHABLE" || e.started) throw e;
      this.#drop();
      await new Promise((r) => setTimeout(r, this.o.reconnectDelayMs ?? 1000));
      return await this.#run(cmd, opts);
    }
  };

  close(): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.#drop();
  }

  #drop() {
    const c = this.#client;
    this.#client = null;
    this.#connecting = null;
    try { c?.end(); } catch {}
  }

  #connect(): Promise<Client> {
    if (this.#client) return Promise.resolve(this.#client);
    if (this.#connecting) return this.#connecting;
    this.#connecting = (async () => {
      let sock: Duplex;
      try {
        sock = await this.o.socket();
      } catch (e) {
        throw new RemoteError("REMOTE_UNREACHABLE", `could not open transport: ${(e as Error).message}`);
      }
      const c = new Client();
      await new Promise<void>((resolve, reject) => {
        c.once("ready", () => resolve());
        c.once("error", (err: Error & { level?: string }) => {
          reject(
            err.level === "client-authentication"
              ? new RemoteError("REMOTE_AUTH_FAILED", "the remote rejected slaude's key (run /remote key)")
              : new RemoteError("REMOTE_UNREACHABLE", err.message),
          );
        });
        c.connect({
          sock: sock as any,
          username: this.o.username ?? "slaude",
          privateKey: this.o.privateKey,
          readyTimeout: this.o.readyTimeoutMs ?? 30_000,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 3,
          // The tailcat address embeds the server's WireGuard key: the tunnel
          // already authenticates the peer (spec §2 "Host identity").
          hostVerifier: () => true,
        });
      });
      c.on("close", () => { if (this.#client === c) this.#client = null; });
      c.on("error", () => { if (this.#client === c) this.#client = null; });
      this.#client = c;
      this.#connecting = null;
      return c;
    })().catch((e) => {
      this.#connecting = null;
      throw e;
    });
    return this.#connecting;
  }

  async #run(cmd: string, opts: ExecOpts): Promise<ExecResult> {
    const client = await this.#connect();
    this.#active++;
    if (this.#idle) clearTimeout(this.#idle);
    try {
      return await this.#execOn(client, cmd, opts);
    } finally {
      this.#active--;
      if (this.#active === 0) {
        this.#idle = setTimeout(() => this.#drop(), this.o.idleMs ?? 10 * 60_000);
        (this.#idle as any).unref?.();
      }
    }
  }

  #execOn(client: Client, cmd: string, opts: ExecOpts): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      client.exec(wrapCommand(cmd, !!opts.login), (err, ch: ClientChannel) => {
        if (err) return reject(new RemoteError("REMOTE_UNREACHABLE", err.message));
        const out = new Capped(opts.maxOutput ?? DEFAULT_HEAD);
        let errBuf = "";
        let pgid: string | null = null;
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          if (pgid) this.#killGroup(client, pgid);
          ch.close();
        }, opts.timeoutMs);
        ch.on("data", (d: Buffer) => out.push(d.toString("utf8")));
        ch.stderr.on("data", (d: Buffer) => {
          errBuf += d.toString("utf8");
          if (!pgid) {
            const m = errBuf.match(new RegExp(`${PGRP_MARKER}(\\d+)\\n`));
            if (m) pgid = m[1]!;
          }
        });
        let code: number | null = null;
        let exited = false;
        ch.on("exit", (c: number | null) => { exited = true; code = typeof c === "number" ? c : null; });
        ch.on("close", () => {
          clearTimeout(timer);
          if (!exited && !timedOut) {
            // Channel closed without an exit status: the connection dropped
            // mid-command (laptop slept, tailcat stopped). Not a command result.
            this.#drop();
            return reject(new RemoteError("REMOTE_UNREACHABLE", "connection lost while the command was running; it may or may not have completed", true));
          }
          const stderr = errBuf.replace(new RegExp(`${PGRP_MARKER}\\d+\\n`), "");
          const note = timedOut ? `\n[timed out after ${opts.timeoutMs}ms; process group killed]` : "";
          resolve({ stdout: out.text(), stderr: stderr + note, code: timedOut ? null : code, truncated: out.truncated, timedOut });
        });
        if (opts.stdin !== undefined) ch.end(opts.stdin);
        else ch.end();
      });
      // No per-exec client listener: ssh2 closes every open channel when the
      // connection drops, so the channel "close" above always settles this promise.
    });
  }

  /** TERM the group, KILL it after a grace period. Fire-and-forget on the same connection. */
  #killGroup(client: Client, pgid: string) {
    const kill = `kill -TERM -${pgid} 2>/dev/null; i=0; while [ $i -lt ${KILL_GRACE_S} ]; do kill -0 -${pgid} 2>/dev/null || exit 0; sleep 1; i=$((i+1)); done; kill -KILL -${pgid} 2>/dev/null; exit 0`;
    client.exec(kill, (e, ch) => { if (!e) { ch.on("data", () => {}); ch.stderr.on("data", () => {}); ch.end(); } });
  }
}
```

Note: `pgid` is digits only (regex `\d+`), so interpolating it into the kill command is safe.

- [ ] **Step 5: Implement `tailcat.ts`**

```ts
import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import type { SocketFactory } from "./conn";
import { isTailcatAddr } from "./shell";

/** `tailcat <addr> 22` as a byte pipe: its stdio is the SSH socket. */
export function tailcatSocket(addr: string, bin = "tailcat"): SocketFactory {
  if (!isTailcatAddr(addr)) throw new Error("invalid tailcat address");
  return () => {
    const p = spawn(bin, [addr, "22"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
    // tailcat logs progress lines ("# Selected ...") on stderr: drop them; they include the address.
    p.stderr.on("data", () => {});
    const d = Duplex.from({ readable: p.stdout, writable: p.stdin });
    d.on("close", () => p.kill());
    p.on("exit", () => d.destroy());
    return d;
  };
}

/** Path to the remote as tailcat sees it: a direct UDP path, a DERP relay, or nothing. */
export async function tailcatPing(addr: string, bin = "tailcat"): Promise<"direct" | "relayed" | "unreachable"> {
  if (!isTailcatAddr(addr)) return "unreachable";
  const p = Bun.spawn([bin, "ping", "--timeout=5s", addr], { stdout: "pipe", stderr: "pipe" });
  const text = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  await p.exited;
  if (!/pong/i.test(text)) return "unreachable";
  return /via DERP/i.test(text) ? "relayed" : "direct";
}
```

- [ ] **Step 6: Run tests**

Run: `bun test tests/remote/conn.test.ts`
Expected: PASS (9 tests). If the orphan test flakes on CI load, raise its `Bun.sleep` to 3000 — do not weaken the assertion.

- [ ] **Step 7: Commit**

```bash
git add src/remote/conn.ts src/remote/tailcat.ts tests/remote/ssh-test-server.ts tests/remote/conn.test.ts
git commit -m "feat(remote): ssh exec over a pluggable socket with group-kill timeouts and reconnect"
```

---

### Task 4: Helper subprocess and client

**Files:**
- Create: `src/remote/helper-main.ts`, `src/remote/helper-client.ts`
- Test: `tests/remote/helper.test.ts`

**Interfaces:**
- Consumes: `RemoteConn`, `tailcatSocket` (Task 3), types (Task 2)
- Produces:
  - Wire protocol (JSON lines):
    - parent → helper: `{ t: "init", transport: { kind: "tailcat"; addr: string } | { kind: "tcp"; host: string; port: number }, privateKey: string }`, then `{ t: "exec", id: number, cmd: string, opts: ExecOpts }`
    - helper → parent: `{ t: "ready" }`, `{ t: "result", id, ok: true, res: ExecResult }` or `{ t: "result", id, ok: false, code: RemoteErrorCode | "INTERNAL", started: boolean, message: string }`
  - `class HelperClient implements RemoteHandle { constructor(o: { transport; privateKey: string; onDispose?: (exec: Exec) => Promise<void> }); exec: Exec; release(): Promise<void>; dispose(): Promise<void> }` — `release` stops the helper (a later `exec` respawns it); `dispose` runs `onDispose` first, then releases.

- [ ] **Step 1: Write the failing test**

`tests/remote/helper.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { utils } from "ssh2";
import { HelperClient } from "../../src/remote/helper-client";
import { startTestSshServer } from "./ssh-test-server";

const pair = utils.generateKeyPairSync("ed25519");
let srv: Awaited<ReturnType<typeof startTestSshServer>>;
beforeAll(async () => { srv = await startTestSshServer({ authorizedPublicKey: pair.public }); });
afterAll(async () => { await srv.stop(); });

const mk = () => new HelperClient({ transport: { kind: "tcp", host: "127.0.0.1", port: srv.port }, privateKey: pair.private });

describe("HelperClient", () => {
  it("execs through the helper subprocess", async () => {
    const h = mk();
    const r = await h.exec("echo via-helper", { timeoutMs: 5000 });
    expect(r.stdout).toBe("via-helper\n");
    await h.dispose();
  });

  it("surfaces transport errors with their code", async () => {
    const bad = utils.generateKeyPairSync("ed25519");
    const h = new HelperClient({ transport: { kind: "tcp", host: "127.0.0.1", port: srv.port }, privateKey: bad.private });
    await expect(h.exec("true", { timeoutMs: 5000 })).rejects.toMatchObject({ code: "REMOTE_AUTH_FAILED" });
    await h.dispose();
  });

  it("restarts a crashed helper on the next call", async () => {
    const h = mk();
    await h.exec("true", { timeoutMs: 5000 });
    h.__killHelperForTests();
    await Bun.sleep(100);
    const r = await h.exec("echo again", { timeoutMs: 5000 });
    expect(r.stdout).toBe("again\n");
    await h.dispose();
  });

  it("never passes the key through argv or env", async () => {
    const h = mk();
    await h.exec("true", { timeoutMs: 5000 });
    const { argv, env } = h.__spawnInfoForTests();
    expect(argv.join(" ")).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(env)).not.toContain("PRIVATE KEY");
    await h.dispose();
  });

  it("release stops the helper without cleanup; the next exec respawns it", async () => {
    let cleaned = 0;
    const h = new HelperClient({
      transport: { kind: "tcp", host: "127.0.0.1", port: srv.port },
      privateKey: pair.private,
      onDispose: async () => { cleaned++; },
    });
    await h.exec("true", { timeoutMs: 5000 });
    await h.release();
    expect(cleaned).toBe(0);
    expect((await h.exec("echo back", { timeoutMs: 5000 })).stdout).toBe("back\n");
    await h.dispose();
    expect(cleaned).toBe(1);
  });

  it("dispose runs the cleanup hook before stopping the helper", async () => {
    const seen: string[] = [];
    const h = new HelperClient({
      transport: { kind: "tcp", host: "127.0.0.1", port: srv.port },
      privateKey: pair.private,
      onDispose: async (exec) => { seen.push((await exec("echo cleanup", { timeoutMs: 5000 })).stdout); },
    });
    await h.dispose();
    expect(seen).toEqual(["cleanup\n"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/remote/helper.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `helper-main.ts`**

```ts
/**
 * Remote helper subprocess: owns the tailcat child, the SSH connection and the
 * private key, so none of them live in the agent process (spec §4.2).
 * Protocol: JSON lines on stdin/stdout. Exits when stdin closes.
 */
import { createInterface } from "node:readline";
import { connect } from "node:net";
import { RemoteConn } from "./conn";
import { tailcatSocket } from "./tailcat";
import { RemoteError } from "./types";

type Init = {
  t: "init";
  transport: { kind: "tailcat"; addr: string } | { kind: "tcp"; host: string; port: number };
  privateKey: string;
};

let conn: RemoteConn | null = null;
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.t === "init") {
    const i = msg as Init;
    const socket = i.transport.kind === "tailcat"
      ? tailcatSocket(i.transport.addr)
      : ((h: string, p: number) => () => connect(p, h))(i.transport.host, i.transport.port);
    conn = new RemoteConn({ socket, privateKey: i.privateKey });
    send({ t: "ready" });
    return;
  }
  if (msg.t === "exec") {
    if (!conn) return send({ t: "result", id: msg.id, ok: false, code: "INTERNAL", message: "helper not initialised" });
    conn.exec(msg.cmd, msg.opts).then(
      (res) => send({ t: "result", id: msg.id, ok: true, res }),
      (e) => send({
        t: "result", id: msg.id, ok: false,
        code: e instanceof RemoteError ? e.code : "INTERNAL",
        started: e instanceof RemoteError ? e.started : false,
        message: e instanceof RemoteError ? e.message.replace(/^[A-Z_]+: /, "") : String(e?.message ?? e),
      }),
    );
  }
});
rl.on("close", () => { conn?.close(); process.exit(0); });
```

- [ ] **Step 4: Implement `helper-client.ts`**

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { RemoteError, type Exec, type ExecOpts, type ExecResult, type RemoteHandle } from "./types";

type Transport = { kind: "tailcat"; addr: string } | { kind: "tcp"; host: string; port: number };
type Pending = { resolve: (r: ExecResult) => void; reject: (e: Error) => void };

const ENTRY = fileURLToPath(new URL("./helper-main.ts", import.meta.url));

export class HelperClient implements RemoteHandle {
  #child: ChildProcess | null = null;
  #ready: Promise<void> | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #spawnInfo = { argv: [] as string[], env: {} as Record<string, string> };

  constructor(private o: { transport: Transport; privateKey: string; onDispose?: (exec: Exec) => Promise<void> }) {}

  exec: Exec = async (cmd: string, opts: ExecOpts) => {
    await this.#ensure();
    const id = this.#nextId++;
    return new Promise<ExecResult>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child!.stdin!.write(JSON.stringify({ t: "exec", id, cmd, opts }) + "\n");
    });
  };

  async dispose(): Promise<void> {
    if (this.o.onDispose) {
      try { await this.o.onDispose(this.exec); } catch (e) { console.error(`[remote] cleanup failed: ${(e as Error).message}`); }
    }
    await this.release();
  }

  async release(): Promise<void> {
    const c = this.#child;
    this.#child = null;
    this.#ready = null;
    c?.stdin?.end();
    c?.kill();
  }

  #ensure(): Promise<void> {
    if (this.#child && this.#ready) return this.#ready;
    const argv = [process.execPath, ENTRY];
    // Minimal env: the helper needs PATH to find tailcat and HOME for its config.
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    this.#spawnInfo = { argv, env };
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "inherit"], env });
    this.#child = child;
    const rl = createInterface({ input: child.stdout! });
    this.#ready = new Promise<void>((resolve, reject) => {
      rl.on("line", (line) => {
        let m: any;
        try { m = JSON.parse(line); } catch { return; }
        if (m.t === "ready") return resolve();
        if (m.t !== "result") return;
        const p = this.#pending.get(m.id);
        if (!p) return;
        this.#pending.delete(m.id);
        if (m.ok) p.resolve(m.res);
        else if (m.code === "REMOTE_UNREACHABLE" || m.code === "REMOTE_AUTH_FAILED") p.reject(new RemoteError(m.code, m.message, !!m.started));
        else p.reject(new Error(m.message));
      });
      child.once("exit", () => {
        if (this.#child === child) { this.#child = null; this.#ready = null; }
        const err = new RemoteError("REMOTE_UNREACHABLE", "remote helper exited");
        for (const p of this.#pending.values()) p.reject(err);
        this.#pending.clear();
        reject(err);
      });
    });
    child.stdin!.write(JSON.stringify({ t: "init", transport: this.o.transport, privateKey: this.o.privateKey }) + "\n");
    return this.#ready;
  }

  __killHelperForTests() { this.#child?.kill("SIGKILL"); }
  __spawnInfoForTests() { return this.#spawnInfo; }
}
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/remote/helper.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/remote/helper-main.ts src/remote/helper-client.ts tests/remote/helper.test.ts
git commit -m "feat(remote): helper subprocess owns the SSH connection and key"
```

---

### Task 5: File tools — read, write, edit

**Files:**
- Create: `src/remote/tools/files.ts`
- Create: `tests/remote/local-exec.ts` (test helper: an `Exec` that runs the same command strings locally)
- Test: `tests/remote/tools-files.test.ts`

**Interfaces:**
- Consumes: `Exec`, `shq`, `MTIME` (Task 2)
- Produces:
  ```ts
  export type ToolText = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean };
  export class ReadState { get(p: string): string | undefined; set(p: string, mtime: string): void }
  export interface FileCtx { exec: Exec; root: string; state: ReadState }
  export function resolveRemotePath(root: string, p: string): string   // throws Error("outside the remote directory") when not under root
  export async function readTool(ctx: FileCtx, i: { file_path: string; offset?: number; limit?: number }): Promise<ToolText>
  export async function writeTool(ctx: FileCtx, i: { file_path: string; content: string }): Promise<ToolText>
  export async function editTool(ctx: FileCtx, i: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }): Promise<ToolText>
  ```
- Test helper: `localExec: Exec` — runs `wrapCommand(cmd, login)` via `/bin/sh -c`, parses the marker the same way as `RemoteConn`.

- [ ] **Step 1: Local exec test helper**

`tests/remote/local-exec.ts`:

```ts
import { spawn } from "node:child_process";
import { PGRP_MARKER, wrapCommand } from "../../src/remote/shell";
import type { Exec } from "../../src/remote/types";

/** Runs remote command strings on this machine: same wrapper, same parsing. */
export const localExec: Exec = (cmd, opts) =>
  new Promise((resolve) => {
    const p = spawn("/bin/sh", ["-c", wrapCommand(cmd, !!opts.login)], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", timedOut = false;
    const t = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, opts.timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ stdout: out, stderr: err.replace(new RegExp(`${PGRP_MARKER}\\d+\\n`), ""), code: timedOut ? null : code, truncated: false, timedOut });
    });
    p.stdin.end(opts.stdin ?? "");
  });
```

- [ ] **Step 2: Write the failing test**

`tests/remote/tools-files.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadState, readTool, writeTool, editTool, resolveRemotePath } from "../../src/remote/tools/files";
import { localExec } from "./local-exec";

let root: string;
let ctx: { exec: typeof localExec; root: string; state: ReadState };
const text = (r: any) => r.content.map((c: any) => c.text ?? "").join("");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slaude-remote-files-"));
  ctx = { exec: localExec, root, state: new ReadState() };
});

describe("resolveRemotePath", () => {
  it("joins relative paths to root and refuses escapes", () => {
    expect(resolveRemotePath("/r", "a/b.txt")).toBe("/r/a/b.txt");
    expect(resolveRemotePath("/r", "/r/x")).toBe("/r/x");
    expect(() => resolveRemotePath("/r", "../etc/passwd")).toThrow("outside the remote directory");
    expect(() => resolveRemotePath("/r", "/etc/passwd")).toThrow("outside the remote directory");
  });
});

describe("read", () => {
  it("returns cat -n formatted lines with offset/limit", async () => {
    writeFileSync(join(root, "f.txt"), "a\nb\nc\nd\n");
    const r = await readTool(ctx, { file_path: "f.txt", offset: 2, limit: 2 });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe("     2\tb\n     3\tc");
  });
  it("handles hostile file names literally", async () => {
    const name = "a b'$(touch pwned).txt";
    writeFileSync(join(root, name), "safe\n");
    const r = await readTool(ctx, { file_path: name });
    expect(text(r)).toBe("     1\tsafe");
    expect(await Bun.file(join(root, "pwned")).exists()).toBe(false);
  });
  it("reports a missing file as a tool error", async () => {
    const r = await readTool(ctx, { file_path: "nope.txt" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("does not exist");
  });
  it("returns images as image blocks", async () => {
    writeFileSync(join(root, "p.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = await readTool(ctx, { file_path: "p.png" });
    expect(r.content[0]).toEqual({ type: "image", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"), mimeType: "image/png" });
  });
  it("rejects pdf in v1", async () => {
    writeFileSync(join(root, "d.pdf"), "%PDF");
    const r = await readTool(ctx, { file_path: "d.pdf" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("not supported in remote mode");
  });
});

describe("write", () => {
  it("creates a new file and parent directories without a prior read", async () => {
    const r = await writeTool(ctx, { file_path: "deep/new.txt", content: "hi\n" });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(root, "deep/new.txt"), "utf8")).toBe("hi\n");
  });
  it("refuses to overwrite an existing file that was not read", async () => {
    writeFileSync(join(root, "e.txt"), "old");
    const r = await writeTool(ctx, { file_path: "e.txt", content: "new" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("has not been read yet");
    expect(readFileSync(join(root, "e.txt"), "utf8")).toBe("old");
  });
  it("overwrites after a read", async () => {
    writeFileSync(join(root, "e.txt"), "old");
    await readTool(ctx, { file_path: "e.txt" });
    const r = await writeTool(ctx, { file_path: "e.txt", content: "new" });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(root, "e.txt"), "utf8")).toBe("new");
  });
  it("refuses when the file changed after the read (user edited it)", async () => {
    writeFileSync(join(root, "e.txt"), "old");
    await readTool(ctx, { file_path: "e.txt" });
    writeFileSync(join(root, "e.txt"), "user change");
    utimesSync(join(root, "e.txt"), new Date(), new Date(Date.now() + 5000));
    const r = await writeTool(ctx, { file_path: "e.txt", content: "agent" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("modified since read");
    expect(readFileSync(join(root, "e.txt"), "utf8")).toBe("user change");
  });
});

describe("edit", () => {
  beforeEach(async () => {
    writeFileSync(join(root, "c.ts"), "const a = 1;\nconst b = 1;\n");
  });
  it("requires a prior read", async () => {
    const r = await editTool(ctx, { file_path: "c.ts", old_string: "a = 1", new_string: "a = 2" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("has not been read yet");
  });
  it("replaces a unique match", async () => {
    await readTool(ctx, { file_path: "c.ts" });
    const r = await editTool(ctx, { file_path: "c.ts", old_string: "a = 1", new_string: "a = 2" });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(root, "c.ts"), "utf8")).toBe("const a = 2;\nconst b = 1;\n");
  });
  it("refuses an ambiguous match unless replace_all", async () => {
    await readTool(ctx, { file_path: "c.ts" });
    const r = await editTool(ctx, { file_path: "c.ts", old_string: "= 1", new_string: "= 3" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Found 2 matches");
    const all = await editTool(ctx, { file_path: "c.ts", old_string: "= 1", new_string: "= 3", replace_all: true });
    expect(all.isError).toBeFalsy();
    expect(readFileSync(join(root, "c.ts"), "utf8")).toBe("const a = 3;\nconst b = 3;\n");
  });
  it("reports a missing string", async () => {
    await readTool(ctx, { file_path: "c.ts" });
    const r = await editTool(ctx, { file_path: "c.ts", old_string: "zzz", new_string: "y" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("not found");
  });
  it("allows two edits in a row (state refreshed after each write)", async () => {
    await readTool(ctx, { file_path: "c.ts" });
    await editTool(ctx, { file_path: "c.ts", old_string: "a = 1", new_string: "a = 2" });
    const r = await editTool(ctx, { file_path: "c.ts", old_string: "b = 1", new_string: "b = 2" });
    expect(r.isError).toBeFalsy();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/remote/tools-files.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `files.ts`**

```ts
import { posix } from "node:path";
import { MTIME, shq } from "../shell";
import type { Exec } from "../types";

export type ToolText = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
  /** Remote exit code, for the audit line only; stripped before returning to the SDK. */
  exitCode?: number | null;
};
export const ok = (text: string): ToolText => ({ content: [{ type: "text", text }] });
export const fail = (text: string): ToolText => ({ content: [{ type: "text", text }], isError: true });

/** path → mtime seen at the last read/write, per session. */
export class ReadState {
  #m = new Map<string, string>();
  get(p: string) { return this.#m.get(p); }
  set(p: string, mtime: string) { this.#m.set(p, mtime); }
}

export interface FileCtx { exec: Exec; root: string; state: ReadState }

const IO_TIMEOUT = 60_000;
const MAX_FILE_CHARS = 10_000_000;
const DEFAULT_LIMIT = 2000;
const MAX_LINE = 2000;
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const UNSUPPORTED = new Set(["pdf", "ipynb"]);

/** Jail to the chosen directory — prevents accidents, not a security boundary (spec §5.3). */
export function resolveRemotePath(root: string, p: string): string {
  const abs = posix.normalize(p.startsWith("/") ? p : posix.join(root, p));
  const rel = posix.relative(root, abs);
  if (rel.startsWith("..") || posix.isAbsolute(rel)) throw new Error(`${p} is outside the remote directory ${root}`);
  return abs;
}

const ext = (p: string) => (p.split(".").pop() ?? "").toLowerCase();

/** `P=...; exists/dir checks; print mtime then a newline, then <body>`. Missing → exit 2 + marker. */
function withFile(path: string, body: string): string {
  return `P=${shq(path)}; if [ ! -e "$P" ]; then echo __ENOENT__ >&2; exit 2; fi; if [ -d "$P" ]; then echo __EISDIR__ >&2; exit 2; fi; ${MTIME} "$P"; printf '\\n'; ${body}`;
}

function splitMtime(stdout: string): { mtime: string; body: string } {
  const i = stdout.indexOf("\n");
  return { mtime: stdout.slice(0, i), body: stdout.slice(i + 1) };
}

function fileError(path: string, stderr: string): string {
  if (stderr.includes("__ENOENT__")) return `File does not exist: ${path}`;
  if (stderr.includes("__EISDIR__")) return `${path} is a directory, not a file`;
  return stderr.trim() || "remote command failed";
}

export async function readTool(ctx: FileCtx, i: { file_path: string; offset?: number; limit?: number }): Promise<ToolText> {
  let path: string;
  try { path = resolveRemotePath(ctx.root, i.file_path); } catch (e) { return fail((e as Error).message); }
  const e = ext(path);
  if (UNSUPPORTED.has(e)) return fail(`Reading .${e} files is not supported in remote mode yet.`);
  if (IMAGE_TYPES[e]) {
    const r = await ctx.exec(withFile(path, `base64 < "$P" | tr -d '\\n'`), { timeoutMs: IO_TIMEOUT, maxOutput: MAX_FILE_CHARS });
    if (r.code !== 0) return fail(fileError(i.file_path, r.stderr));
    if (r.truncated) return fail(`${i.file_path} is too large to read in remote mode.`);
    const { mtime, body } = splitMtime(r.stdout);
    ctx.state.set(path, mtime);
    return { content: [{ type: "image", data: body, mimeType: IMAGE_TYPES[e]! }] };
  }
  const start = Math.max(1, Math.floor(i.offset ?? 1));
  const end = start + Math.max(1, Math.floor(i.limit ?? DEFAULT_LIMIT)) - 1;
  const r = await ctx.exec(withFile(path, `sed -n '${start},${end}p' < "$P"`), { timeoutMs: IO_TIMEOUT });
  if (r.code !== 0) return fail(fileError(i.file_path, r.stderr));
  const { mtime, body } = splitMtime(r.stdout);
  ctx.state.set(path, mtime);
  if (body === "") return ok(start === 1 ? "(file is empty)" : `(no lines at offset ${start})`);
  const lines = body.endsWith("\n") ? body.slice(0, -1).split("\n") : body.split("\n");
  return ok(
    lines
      .map((l, k) => `${String(start + k).padStart(6)}\t${l.length > MAX_LINE ? l.slice(0, MAX_LINE) + "…" : l}`)
      .join("\n") + (r.truncated ? "\n[output truncated]" : ""),
  );
}

/** Write guarded by the mtime seen at read time: "" = must not exist. Prints the new mtime. */
function guardedWrite(path: string, expected: string): string {
  return `P=${shq(path)}; EXP=${shq(expected)}; if [ -e "$P" ]; then M=$(${MTIME} "$P"); [ "$M" = "$EXP" ] || { echo __STALE__ >&2; exit 3; }; fi; mkdir -p "$(dirname "$P")" && cat > "$P" && ${MTIME} "$P"`;
}

function staleMessage(neverRead: boolean): string {
  return neverRead
    ? "File has not been read yet. Read it first before writing to it."
    : "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";
}

export async function writeTool(ctx: FileCtx, i: { file_path: string; content: string }): Promise<ToolText> {
  let path: string;
  try { path = resolveRemotePath(ctx.root, i.file_path); } catch (e) { return fail((e as Error).message); }
  const seen = ctx.state.get(path);
  const r = await ctx.exec(guardedWrite(path, seen ?? ""), { stdin: i.content, timeoutMs: IO_TIMEOUT });
  if (r.stderr.includes("__STALE__")) return fail(staleMessage(seen === undefined));
  if (r.code !== 0) return fail(r.stderr.trim() || "write failed");
  ctx.state.set(path, r.stdout.trim());
  return ok(`File ${seen === undefined ? "created" : "updated"} successfully at: ${path}`);
}

export async function editTool(
  ctx: FileCtx,
  i: { file_path: string; old_string: string; new_string: string; replace_all?: boolean },
): Promise<ToolText> {
  let path: string;
  try { path = resolveRemotePath(ctx.root, i.file_path); } catch (e) { return fail((e as Error).message); }
  const seen = ctx.state.get(path);
  if (seen === undefined) return fail(staleMessage(true));
  if (i.old_string === i.new_string) return fail("No changes to make: old_string and new_string are exactly the same.");
  const r = await ctx.exec(withFile(path, `cat < "$P"`), { timeoutMs: IO_TIMEOUT, maxOutput: MAX_FILE_CHARS });
  if (r.code !== 0) return fail(fileError(i.file_path, r.stderr));
  if (r.truncated) return fail(`${i.file_path} is too large to edit in remote mode.`);
  const { mtime, body } = splitMtime(r.stdout);
  if (mtime !== seen) return fail(staleMessage(false));
  const count = i.old_string === "" ? 0 : body.split(i.old_string).length - 1;
  if (count === 0) return fail(`String to replace not found in file.\nString: ${i.old_string}`);
  if (count > 1 && !i.replace_all) {
    return fail(`Found ${count} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${i.old_string}`);
  }
  const next = i.replace_all ? body.split(i.old_string).join(i.new_string) : body.replace(i.old_string, () => i.new_string);
  const w = await ctx.exec(guardedWrite(path, mtime), { stdin: next, timeoutMs: IO_TIMEOUT });
  if (w.stderr.includes("__STALE__")) return fail(staleMessage(false));
  if (w.code !== 0) return fail(w.stderr.trim() || "edit failed");
  ctx.state.set(path, w.stdout.trim());
  return ok(`The file ${path} has been updated.`);
}
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/remote/tools-files.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/remote/tools/files.ts tests/remote/local-exec.ts tests/remote/tools-files.test.ts
git commit -m "feat(remote): read/write/edit over exec with read-before-write and mtime guard"
```

---

### Task 6: Search and bash tools

**Files:**
- Create: `src/remote/tools/search.ts`, `src/remote/tools/bash.ts`
- Test: `tests/remote/tools-search.test.ts`, `tests/remote/tools-bash.test.ts`

**Interfaces:**
- Consumes: `FileCtx`, `ToolText`, `ok`, `fail`, `resolveRemotePath` (Task 5); `shq`, `sanitizeKey` (Task 2)
- Produces:
  ```ts
  // search.ts
  export async function globTool(ctx: FileCtx, i: { pattern: string; path?: string }): Promise<ToolText>
  export interface GrepInput { pattern: string; path?: string; glob?: string; type?: string; output_mode?: "content" | "files_with_matches" | "count"; "-i"?: boolean; "-n"?: boolean; "-A"?: number; "-B"?: number; "-C"?: number; head_limit?: number; multiline?: boolean }
  export async function grepTool(ctx: FileCtx, i: GrepInput): Promise<ToolText>
  // bash.ts
  export interface BashCtx { exec: Exec; root: string; sessionKey: string; cwd: { value: string }; bg: Map<string, number> }
  export async function bashTool(ctx: BashCtx, i: { command: string; timeout?: number; description?: string; run_in_background?: boolean }): Promise<ToolText>
  export async function bashOutputTool(ctx: BashCtx, i: { bash_id: string }): Promise<ToolText>
  export async function bashKillTool(ctx: BashCtx, i: { shell_id: string }): Promise<ToolText>
  export function cleanupCommand(sessionKey: string): string
  ```

- [ ] **Step 1: Write the failing search test**

`tests/remote/tools-search.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadState } from "../../src/remote/tools/files";
import { globTool, grepTool } from "../../src/remote/tools/search";
import { localExec } from "./local-exec";

let root: string;
const ctx = () => ({ exec: localExec, root, state: new ReadState() });
const text = (r: any) => r.content.map((c: any) => c.text).join("");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "slaude-remote-search-"));
  mkdirSync(join(root, "src/lib"), { recursive: true });
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "src/a.ts"), "export const alpha = 1;\n");
  writeFileSync(join(root, "src/lib/b.ts"), "export const Beta = 2;\nconst alpha2 = 3;\n");
  writeFileSync(join(root, "README.md"), "alpha docs\n");
  writeFileSync(join(root, ".git/HEAD"), "alpha in git\n");
  writeFileSync(join(root, "odd name$.ts"), "alpha odd\n");
  utimesSync(join(root, "src/lib/b.ts"), new Date(), new Date(Date.now() + 10_000));
});

describe("glob", () => {
  it("finds nested files, newest first, absolute paths, skipping .git", async () => {
    const out = text(await globTool(ctx(), { pattern: "**/*.ts" })).split("\n");
    expect(out[0]).toBe(join(root, "src/lib/b.ts"));
    expect(out).toContain(join(root, "src/a.ts"));
    expect(out.some((l) => l.includes(".git"))).toBe(false);
  });
  it("reports no files", async () => {
    expect(text(await globTool(ctx(), { pattern: "**/*.rs" }))).toBe("No files found");
  });
  it("refuses a path outside the root", async () => {
    expect((await globTool(ctx(), { pattern: "*", path: "/etc" })).isError).toBe(true);
  });
});

describe("grep", () => {
  it("files_with_matches by default, skipping .git", async () => {
    const out = text(await grepTool(ctx(), { pattern: "alpha" }));
    expect(out).toContain(join(root, "src/a.ts"));
    expect(out).toContain(join(root, "README.md"));
    expect(out).toContain("odd name$.ts");
    expect(out).not.toContain(".git");
  });
  it("content mode with line numbers and case-insensitive", async () => {
    const out = text(await grepTool(ctx(), { pattern: "beta", output_mode: "content", "-i": true }));
    expect(out).toContain("b.ts:1:export const Beta = 2;");
  });
  it("glob filter and type filter", async () => {
    expect(text(await grepTool(ctx(), { pattern: "alpha", glob: "*.md" }))).not.toContain("a.ts");
    const t = text(await grepTool(ctx(), { pattern: "alpha", type: "ts" }));
    expect(t).toContain("a.ts");
    expect(t).not.toContain("README.md");
  });
  it("count mode", async () => {
    expect(text(await grepTool(ctx(), { pattern: "alpha", output_mode: "count", path: "src" }))).toContain(":1");
  });
  it("head_limit caps output lines", async () => {
    const out = text(await grepTool(ctx(), { pattern: "alpha", head_limit: 1 }));
    expect(out.trim().split("\n").length).toBe(1);
  });
  it("no matches", async () => {
    expect(text(await grepTool(ctx(), { pattern: "zzz_nothing" }))).toBe("No matches found");
  });
  it("a pattern starting with a dash is a pattern, not a flag", async () => {
    writeFileSync(join(root, "dash.txt"), "-rf here\n");
    expect(text(await grepTool(ctx(), { pattern: "-rf" }))).toContain("dash.txt");
  });
});
```

- [ ] **Step 2: Write the failing bash test**

`tests/remote/tools-bash.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool, bashOutputTool, bashKillTool, cleanupCommand } from "../../src/remote/tools/bash";
import { localExec } from "./local-exec";

let root: string;
let ctx: any;
const text = (r: any) => r.content.map((c: any) => c.text).join("");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slaude-remote-bash-"));
  mkdirSync(join(root, "sub"));
  ctx = { exec: localExec, root, sessionKey: `test${process.pid}${Date.now()}`, cwd: { value: root }, bg: new Map() };
});
afterEach(async () => { await localExec(cleanupCommand(ctx.sessionKey), { timeoutMs: 20_000 }); });

describe("bash", () => {
  it("runs in the root dir and returns output", async () => {
    const r = await bashTool(ctx, { command: "pwd -P; echo hi" });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("hi");
  });
  it("keeps the working directory between calls, like the built-in", async () => {
    await bashTool(ctx, { command: "cd sub" });
    expect(text(await bashTool(ctx, { command: "basename \"$(pwd)\"" })).trim()).toBe("sub");
  });
  it("marks non-zero exit as an error with the code", async () => {
    const r = await bashTool(ctx, { command: "echo nope >&2; exit 4" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Exit code 4");
    expect(text(r)).toContain("nope");
  });
  it("times out and says so", async () => {
    const r = await bashTool(ctx, { command: "sleep 5", timeout: 300 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("timed out");
  });
});

describe("background jobs", () => {
  it("the pid file holds the job's own process group, even for a session's first job", async () => {
    const start = await bashTool(ctx, { command: "sleep 30", run_in_background: true });
    const id = text(start).match(/ID: ([0-9a-f]+)/)![1]!;
    const r = await localExec(
      `P=$(cat "$HOME"/.slaude-bg/${ctx.sessionKey}/${id}.pid); [ "$(ps -o pgid= -p "$P" | tr -d ' ')" = "$P" ] && echo own-group`,
      { timeoutMs: 5000 },
    );
    expect(r.stdout.trim()).toBe("own-group");
    expect(text(await bashOutputTool(ctx, { bash_id: id }))).toContain("running");
  });

  it("start → output (incremental) → exit status", async () => {
    const start = await bashTool(ctx, { command: "echo one; sleep 1; echo two", run_in_background: true });
    const id = text(start).match(/ID: ([0-9a-f]+)/)![1]!;
    await Bun.sleep(300);
    const first = text(await bashOutputTool(ctx, { bash_id: id }));
    expect(first).toContain("one");
    expect(first).toContain("running");
    await Bun.sleep(1500);
    const second = text(await bashOutputTool(ctx, { bash_id: id }));
    expect(second).toContain("two");
    expect(second).not.toContain("one");
    expect(second).toContain("exit code 0");
  });
  it("kill stops the job's whole group", async () => {
    const start = await bashTool(ctx, { command: "sleep 60 & sleep 60", run_in_background: true });
    const id = text(start).match(/ID: ([0-9a-f]+)/)![1]!;
    await Bun.sleep(300);
    expect((await bashKillTool(ctx, { shell_id: id })).isError).toBeFalsy();
    expect(text(await bashOutputTool(ctx, { bash_id: id }))).toMatch(/killed|exit/);
  });
  it("rejects ids that are not ours", async () => {
    expect((await bashOutputTool(ctx, { bash_id: "../../etc" })).isError).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/remote/tools-search.test.ts tests/remote/tools-bash.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `search.ts`**

```ts
import { posix } from "node:path";
import { shq } from "../shell";
import { fail, ok, resolveRemotePath, type FileCtx, type ToolText } from "./files";

const SEARCH_TIMEOUT = 60_000;
const GLOB_LIMIT = 100;

/** Glob → find(1) -path pattern. find's `*` already spans `/`, so `**\/` collapses to nothing. */
function globToFind(pattern: string): string {
  return "./" + pattern.replace(/^\.\//, "").replace(/\*\*\//g, "");
}

export async function globTool(ctx: FileCtx, i: { pattern: string; path?: string }): Promise<ToolText> {
  let base: string;
  try { base = resolveRemotePath(ctx.root, i.path ?? ctx.root); } catch (e) { return fail((e as Error).message); }
  const cmd =
    `cd ${shq(base)} || exit 2; ` +
    `if command -v rg >/dev/null 2>&1; then rg --files --hidden -g '!.git' -g ${shq(i.pattern)}; ` +
    `else find . -type f -not -path '*/.git/*' -path ${shq(globToFind(i.pattern))} | sed 's|^\\./||'; fi ` +
    `| perl -ne 'chomp; my @s = stat $_; print "$s[9]\\t$_\\n"' | sort -rn | head -n ${GLOB_LIMIT} | cut -f2-`;
  const r = await ctx.exec(cmd, { timeoutMs: SEARCH_TIMEOUT });
  if (r.code !== 0 && !r.stdout) return fail(r.stderr.trim() || "glob failed");
  const files = r.stdout.split("\n").filter(Boolean).map((f) => posix.join(base, f));
  return ok(files.length ? files.join("\n") : "No files found");
}

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  "-i"?: boolean;
  "-n"?: boolean;
  "-A"?: number;
  "-B"?: number;
  "-C"?: number;
  head_limit?: number;
  multiline?: boolean;
}

/** ripgrep type → grep --include globs, for remotes without rg. */
const TYPE_GLOBS: Record<string, string[]> = {
  ts: ["*.ts", "*.tsx", "*.mts", "*.cts"], js: ["*.js", "*.jsx", "*.mjs", "*.cjs"], py: ["*.py"],
  go: ["*.go"], rust: ["*.rs"], java: ["*.java"], c: ["*.c", "*.h"], cpp: ["*.cpp", "*.cc", "*.hpp", "*.hh"],
  md: ["*.md", "*.markdown"], json: ["*.json"], yaml: ["*.yaml", "*.yml"], sh: ["*.sh", "*.bash"],
  html: ["*.html", "*.htm"], css: ["*.css"], sql: ["*.sql"], rb: ["*.rb"], swift: ["*.swift"], kotlin: ["*.kt", "*.kts"],
};

const num = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined);

function rgArgs(i: GrepInput, base: string): string {
  const mode = i.output_mode ?? "files_with_matches";
  const a = ["rg", "--hidden", "-g", shq("!.git")];
  if (mode === "files_with_matches") a.push("-l");
  if (mode === "count") a.push("-c");
  if (mode === "content" && i["-n"] !== false) a.push("-n");
  if (i["-i"]) a.push("-i");
  for (const f of ["-A", "-B", "-C"] as const) { const v = num(i[f]); if (mode === "content" && v !== undefined) a.push(f, String(v)); }
  if (i.glob) a.push("-g", shq(i.glob));
  if (i.type) a.push("-t", shq(i.type));
  if (i.multiline) a.push("-U", "--multiline-dotall");
  a.push("-e", shq(i.pattern), "--", shq(base));
  return a.join(" ");
}

function grepArgs(i: GrepInput, base: string): string | null {
  const mode = i.output_mode ?? "files_with_matches";
  const a = ["grep", "-rIE", "--exclude-dir=.git"];
  if (mode === "files_with_matches") a.push("-l");
  if (mode === "count") a.push("-c");
  if (mode === "content" && i["-n"] !== false) a.push("-n");
  if (i["-i"]) a.push("-i");
  for (const f of ["-A", "-B", "-C"] as const) { const v = num(i[f]); if (mode === "content" && v !== undefined) a.push(f, String(v)); }
  if (i.glob) a.push(`--include=${shq(i.glob)}`);
  if (i.type) {
    const globs = TYPE_GLOBS[i.type];
    if (!globs) return null;
    for (const g of globs) a.push(`--include=${shq(g)}`);
  }
  a.push("-e", shq(i.pattern), "--", shq(base));
  return a.join(" ");
}

export async function grepTool(ctx: FileCtx, i: GrepInput): Promise<ToolText> {
  let base: string;
  try { base = resolveRemotePath(ctx.root, i.path ?? ctx.root); } catch (e) { return fail((e as Error).message); }
  const rg = rgArgs(i, base);
  const grep = grepArgs(i, base);
  const noRg = i.multiline
    ? `echo __NORG_MULTILINE__ >&2; exit 4`
    : grep === null
      ? `echo __NORG_TYPE__ >&2; exit 4`
      : grep;
  // count mode: drop files with zero matches (grep -c prints them).
  const post = (i.output_mode === "count" ? ` | grep -v ':0$'` : "") + (num(i.head_limit) ? ` | head -n ${num(i.head_limit)}` : "");
  const cmd = `if command -v rg >/dev/null 2>&1; then ${rg}; else ${noRg}; fi${post}`;
  const r = await ctx.exec(cmd, { timeoutMs: 60_000 });
  if (r.stderr.includes("__NORG_MULTILINE__")) return fail("multiline search needs ripgrep (rg) installed on the remote machine.");
  if (r.stderr.includes("__NORG_TYPE__")) return fail(`type "${i.type}" needs ripgrep (rg) on the remote; use the glob parameter instead.`);
  const out = r.stdout.replace(/\n$/, "");
  if (!out) return r.code === 1 || r.code === 0 ? ok("No matches found") : fail(r.stderr.trim() || "grep failed");
  return ok(out + (r.truncated ? "\n[output truncated]" : ""));
}
```

Note: the pipeline's exit status is that of the last command; "no matches" is detected by empty stdout, not by the exit code.

- [ ] **Step 5: Implement `bash.ts`**

```ts
import { randomBytes } from "node:crypto";
import { sanitizeKey, shq } from "../shell";
import type { Exec } from "../types";
import { fail, ok, type ToolText } from "./files";

export interface BashCtx {
  exec: Exec;
  root: string;
  sessionKey: string;
  /** Working directory carried between calls (the built-in Bash keeps cwd too). */
  cwd: { value: string };
  /** job id → byte offset already returned by bash_output. */
  bg: Map<string, number>;
}

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const CWD_MARK = "__SLAUDE_CWD__";
const JOB_ID = /^[0-9a-f]{8}$/;

const bgDir = (key: string) => `"$HOME"/.slaude-bg/${sanitizeKey(key)}`;

export async function bashTool(
  ctx: BashCtx,
  i: { command: string; timeout?: number; description?: string; run_in_background?: boolean },
): Promise<ToolText> {
  const enter = `cd ${shq(ctx.cwd.value)} 2>/dev/null || cd ${shq(ctx.root)}`;
  if (i.run_in_background) return startBackground(ctx, enter, i.command);
  const timeoutMs = Math.min(Math.max(1, i.timeout ?? DEFAULT_TIMEOUT), MAX_TIMEOUT);
  // Newline before the trailer so a trailing comment in the command cannot swallow it.
  const cmd = `${enter}\n${i.command}\n__slaude_rc=$?; printf '\\n${CWD_MARK}%s' "$(pwd)"; exit $__slaude_rc`;
  const r = await ctx.exec(cmd, { timeoutMs, login: true });
  let stdout = r.stdout;
  const at = stdout.lastIndexOf(`\n${CWD_MARK}`);
  if (at >= 0) {
    ctx.cwd.value = stdout.slice(at + CWD_MARK.length + 1).trim() || ctx.cwd.value;
    stdout = stdout.slice(0, at);
  }
  const body = [stdout.replace(/\n$/, ""), r.stderr.replace(/\n$/, "")].filter(Boolean).join("\n");
  if (r.timedOut) return { ...fail(`${body}\nCommand timed out after ${timeoutMs}ms`.trim()), exitCode: null };
  if (r.code !== 0) return { ...fail(`Exit code ${r.code}\n${body}`.trim()), exitCode: r.code };
  return { ...ok(body || "(no output)"), exitCode: 0 };
}

async function startBackground(ctx: BashCtx, enter: string, command: string): Promise<ToolText> {
  const id = randomBytes(4).toString("hex");
  const d = bgDir(ctx.sessionKey);
  const inner = `${command}\n__rc=$?; echo $__rc > ${d}/${id}.exit`;
  // Only the `nohup perl …` simple command may be backgrounded: `a && b && c &`
  // would background the whole AND-list, racing mkdir and making $! the
  // subshell's pid instead of the job's process group.
  const cmd =
    `D=${d}; mkdir -p "$D" || exit 2; ${enter} || exit 2; ` +
    `nohup perl -e 'setpgrp(0,0); exec @ARGV' bash -lc ${shq(inner)} > "$D/${id}.log" 2>&1 < /dev/null & ` +
    `echo $! > "$D/${id}.pid"; cat "$D/${id}.pid"`;
  const r = await ctx.exec(cmd, { timeoutMs: 30_000 });
  if (r.code !== 0) return fail(r.stderr.trim() || "could not start background job");
  ctx.bg.set(id, 0);
  return ok(`Command running in background with ID: ${id}. Read its output with mcp__remote__bash_output (bash_id "${id}"); stop it with mcp__remote__bash_kill (shell_id "${id}").`);
}

export async function bashOutputTool(ctx: BashCtx, i: { bash_id: string }): Promise<ToolText> {
  if (!JOB_ID.test(i.bash_id)) return fail(`No background job with ID ${i.bash_id}`);
  const d = bgDir(ctx.sessionKey);
  const off = ctx.bg.get(i.bash_id) ?? 0;
  const cmd =
    `D=${d}; [ -e "$D/${i.bash_id}.pid" ] || { echo __NOJOB__ >&2; exit 2; }; ` +
    `tail -c +${off + 1} "$D/${i.bash_id}.log"; printf '\\n__SLAUDE_BG__'; ` +
    `if [ -e "$D/${i.bash_id}.exit" ]; then printf 'exit:'; cat "$D/${i.bash_id}.exit"; ` +
    `elif kill -0 -"$(cat "$D/${i.bash_id}.pid")" 2>/dev/null; then echo running; else echo killed; fi`;
  const r = await ctx.exec(cmd, { timeoutMs: 30_000 });
  if (r.stderr.includes("__NOJOB__")) return fail(`No background job with ID ${i.bash_id}`);
  const at = r.stdout.lastIndexOf("\n__SLAUDE_BG__");
  const output = at >= 0 ? r.stdout.slice(0, at) : r.stdout;
  const state = at >= 0 ? r.stdout.slice(at + "\n__SLAUDE_BG__".length).trim() : "unknown";
  ctx.bg.set(i.bash_id, off + Buffer.byteLength(output, "utf8"));
  const status = state.startsWith("exit:") ? `completed (exit code ${state.slice(5).trim()})` : state;
  return ok(`<status>${status}</status>\n${output || "(no new output)"}`);
}

export async function bashKillTool(ctx: BashCtx, i: { shell_id: string }): Promise<ToolText> {
  if (!JOB_ID.test(i.shell_id)) return fail(`No background job with ID ${i.shell_id}`);
  const d = bgDir(ctx.sessionKey);
  const cmd =
    `PG=$(cat ${d}/${i.shell_id}.pid 2>/dev/null) || { echo __NOJOB__ >&2; exit 2; }; ` +
    `kill -TERM -"$PG" 2>/dev/null; i=0; while [ $i -lt 5 ]; do kill -0 -"$PG" 2>/dev/null || exit 0; sleep 1; i=$((i+1)); done; ` +
    `kill -KILL -"$PG" 2>/dev/null; exit 0`;
  const r = await ctx.exec(cmd, { timeoutMs: 30_000 });
  if (r.stderr.includes("__NOJOB__")) return fail(`No background job with ID ${i.shell_id}`);
  return ok(`Killed background job ${i.shell_id}`);
}

/** Kill every job this session started and remove its files (spec §5.2). */
export function cleanupCommand(sessionKey: string): string {
  const d = bgDir(sessionKey);
  return (
    `D=${d}; [ -d "$D" ] || exit 0; ` +
    `for f in "$D"/*.pid; do [ -e "$f" ] || continue; kill -TERM -"$(cat "$f")" 2>/dev/null; done; sleep 2; ` +
    `for f in "$D"/*.pid; do [ -e "$f" ] || continue; kill -KILL -"$(cat "$f")" 2>/dev/null; done; rm -rf "$D"`
  );
}
```

- [ ] **Step 6: Run tests**

Run: `bun test tests/remote/tools-search.test.ts tests/remote/tools-bash.test.ts`
Expected: PASS. Both files run the grep/find branch on machines without `rg` and the `rg` branch where it is installed — run once with `PATH=/usr/bin:/bin bun test tests/remote/tools-search.test.ts` to force the no-rg branch and confirm it passes too.

- [ ] **Step 7: Commit**

```bash
git add src/remote/tools/search.ts src/remote/tools/bash.ts tests/remote/tools-search.test.ts tests/remote/tools-bash.test.ts
git commit -m "feat(remote): glob/grep with portable fallbacks, bash with cwd and background jobs"
```

---

### Task 7: The `remote` MCP server, aliases, guard, permission mapping

**Files:**
- Create: `src/remote/mcp.ts`
- Test: `tests/remote/mcp.test.ts`

**Interfaces:**
- Consumes: all tools (Tasks 5–6), `RemoteError` (Task 2)
- Produces:
  ```ts
  export const REMOTE_MCP_NAME = "remote";
  export const REMOTE_BUILTINS: readonly ["Bash", "Read", "Write", "Edit", "Glob", "Grep"];
  export const REMOTE_TOOL_ALIASES: Record<string, string>;   // Bash → mcp__remote__bash, …
  export function builtinFor(toolName: string): string | null; // mcp__remote__bash|bash_kill → "Bash", write → "Write", …; null for others
  export function remotePermission(toolName: string, mode: string): "allow" | "ask" | "deny" | null;
  export const denyLocalBuiltins: HookCallback;
  export function createRemoteMcp(o: { exec: Exec; root: string; sessionKey: string }): McpSdkServerConfigWithInstance;
  export function makeRemoteCanUseTool(base: CanUseTool | undefined, getMode: () => string): CanUseTool;
  ```

- [ ] **Step 1: Write the failing test**

`tests/remote/mcp.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import {
  REMOTE_TOOL_ALIASES, builtinFor, remotePermission, denyLocalBuiltins, makeRemoteCanUseTool, createRemoteMcp, REMOTE_MCP_NAME,
} from "../../src/remote/mcp";
import { RemoteError } from "../../src/remote/types";
import { localExec } from "./local-exec";

const sig = { signal: new AbortController().signal } as any;

describe("aliases", () => {
  it("routes the six built-ins to mcp__remote__*", () => {
    expect(REMOTE_TOOL_ALIASES).toEqual({
      Bash: "mcp__remote__bash", Read: "mcp__remote__read", Write: "mcp__remote__write",
      Edit: "mcp__remote__edit", Glob: "mcp__remote__glob", Grep: "mcp__remote__grep",
    });
  });
});

describe("remotePermission — parity with how the SDK treats each built-in", () => {
  const cases: Array<[string, string, "allow" | "ask" | null]> = [
    ["mcp__remote__read", "default", "allow"],
    ["mcp__remote__glob", "default", "allow"],
    ["mcp__remote__grep", "default", "allow"],
    ["mcp__remote__bash_output", "default", "allow"],
    ["mcp__remote__write", "default", "ask"],
    ["mcp__remote__edit", "default", "ask"],
    ["mcp__remote__write", "acceptEdits", "allow"],
    ["mcp__remote__edit", "acceptEdits", "allow"],
    ["mcp__remote__bash", "default", "ask"],
    ["mcp__remote__bash", "acceptEdits", "ask"],
    ["mcp__remote__bash_kill", "default", "ask"],
    ["mcp__remote__bash", "bypassPermissions", "allow"],
    ["mcp__remote__write", "plan", "deny"],
    ["mcp__remote__edit", "plan", "deny"],
    ["mcp__remote__bash", "plan", "deny"],
    ["mcp__remote__bash_kill", "plan", "deny"],
    ["mcp__remote__read", "plan", "allow"],
    ["mcp__slaude_kb__search", "default", null],
    ["Bash", "default", null],
  ];
  for (const [tool, mode, want] of cases as Array<[string, string, "allow" | "ask" | "deny" | null]>) {
    it(`${tool} in ${mode} → ${want}`, () => expect(remotePermission(tool, mode)).toBe(want));
  }
  it("builtinFor maps remote tools to the built-in an approver recognises", () => {
    expect(builtinFor("mcp__remote__bash")).toBe("Bash");
    expect(builtinFor("mcp__remote__bash_kill")).toBe("Bash");
    expect(builtinFor("mcp__remote__edit")).toBe("Edit");
    expect(builtinFor("mcp__other__x")).toBeNull();
  });
});

describe("makeRemoteCanUseTool", () => {
  it("allows read-only remote tools without asking, asks the base resolver under the built-in name otherwise", async () => {
    const asked: string[] = [];
    const base = async (name: string, input: any) => { asked.push(name); return { behavior: "allow", updatedInput: input } as any; };
    const can = makeRemoteCanUseTool(base as any, () => "default");
    expect((await can("mcp__remote__read", { file_path: "a" }, sig)).behavior).toBe("allow");
    await can("mcp__remote__bash", { command: "ls" }, sig);
    await can("mcp__slaude_kb__search", {}, sig);
    expect(asked).toEqual(["Bash", "mcp__slaude_kb__search"]);
  });
  it("denies an ask when there is no resolver", async () => {
    const can = makeRemoteCanUseTool(undefined, () => "default");
    expect((await can("mcp__remote__bash", { command: "ls" }, sig)).behavior).toBe("deny");
  });
  it("plan mode denies remote changes without asking anyone", async () => {
    const asked: string[] = [];
    const can = makeRemoteCanUseTool((async (n: string, input: any) => { asked.push(n); return { behavior: "allow", updatedInput: input }; }) as any, () => "plan");
    expect((await can("mcp__remote__write", { file_path: "a", content: "" }, sig)).behavior).toBe("deny");
    expect(asked).toEqual([]);
  });
});

describe("gating parity with the real permission policy (spec §9)", () => {
  // The gateway and node both gate with permissionPolicy (src/gateway/slack/permission-gate.ts);
  // remote tools must get exactly the decision their built-in gets, incl. SLAUDE_AUTO_ALLOW_TOOLS.
  const { permissionPolicy } = require("../../src/gateway/slack/permission-gate");
  const inputs: Record<string, any> = {
    Bash: { command: "ls -la" }, Write: { file_path: "/r/a", content: "x" }, Edit: { file_path: "/r/a", old_string: "a", new_string: "b" },
  };
  for (const autoAllow of [new Set<string>(), new Set(["Bash", "Write", "Edit"])]) {
    for (const builtin of ["Bash", "Write", "Edit"]) {
      it(`${builtin} with autoAllow=[${[...autoAllow]}] → same decision remotely`, async () => {
        const base = async (name: string, input: any) =>
          permissionPolicy(name, input, autoAllow) ?? { behavior: "deny", message: "APPROVAL_CARD" };
        const can = makeRemoteCanUseTool(base as any, () => "default");
        const local = await base(builtin, inputs[builtin]);
        const remote = await can(REMOTE_TOOL_ALIASES[builtin]!, inputs[builtin], sig);
        expect(remote.behavior).toBe(local.behavior);
      });
    }
  }
});

describe("denyLocalBuiltins", () => {
  it("denies a local built-in and lets aliased (post-alias) names through", async () => {
    const d = await denyLocalBuiltins({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} } as any, "t1", sig);
    expect((d as any).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(await denyLocalBuiltins({ hook_event_name: "PreToolUse", tool_name: "mcp__remote__bash", tool_input: {} } as any, "t1", sig)).toEqual({});
    expect(await denyLocalBuiltins({ hook_event_name: "PreToolUse", tool_name: "WebFetch", tool_input: {} } as any, "t1", sig)).toEqual({});
  });
});

describe("createRemoteMcp", () => {
  it("registers eight tools under the remote server name", () => {
    const s = createRemoteMcp({ exec: localExec, root: "/tmp", sessionKey: "k" });
    expect(s.name).toBe(REMOTE_MCP_NAME);
    const names = Object.keys((s.instance as any)._registeredTools ?? {});
    expect(names.sort()).toEqual(["bash", "bash_kill", "bash_output", "edit", "glob", "grep", "read", "write"]);
  });
  it("turns a transport failure into a tool error with guidance, never a throw", async () => {
    const dead = async () => { throw new RemoteError("REMOTE_UNREACHABLE", "connection closed"); };
    const s = createRemoteMcp({ exec: dead, root: "/tmp", sessionKey: "k" });
    const tool = (s.instance as any)._registeredTools.bash;
    const r = await tool.callback({ command: "ls" }, {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("REMOTE_UNREACHABLE");
    expect(r.content[0].text).toContain("tell the user");
    expect(r.content[0].text).toContain("/remote <new-address>");
  });
  it("audit line carries the exit code and never the command args; exitCode is not returned to the SDK", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (m: string) => { lines.push(String(m)); };
    try {
      const s = createRemoteMcp({ exec: localExec, root: "/tmp", sessionKey: "k" });
      const r = await (s.instance as any)._registeredTools.bash.callback({ command: "sh -c 'exit 3' --secret-token=abc" }, {});
      expect(r.exitCode).toBeUndefined();
    } finally { console.log = orig; }
    const line = lines.find((l) => l.startsWith("[remote] tool=bash"))!;
    expect(line).toContain("subject=sh");
    expect(line).toContain("code=3");
    expect(line).not.toContain("secret-token");
  });
});
```

If `_registeredTools` is not the field name in the installed `@modelcontextprotocol/sdk` version, find the registry field with `bun -e "import {createSdkMcpServer,tool} from '@anthropic-ai/claude-agent-sdk'; const s=createSdkMcpServer({name:'x',tools:[tool('t','d',{},async()=>({content:[]}))]}); console.log(Object.keys(s.instance))"` and use it in both tests; do not change the production code for this.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/remote/mcp.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mcp.ts`**

```ts
import { createSdkMcpServer, tool, type CanUseTool, type HookCallback, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { RemoteError, type Exec } from "./types";
import { ReadState, readTool, writeTool, editTool, fail, type ToolText } from "./tools/files";
import { globTool, grepTool } from "./tools/search";
import { bashTool, bashOutputTool, bashKillTool } from "./tools/bash";

export const REMOTE_MCP_NAME = "remote";
export const REMOTE_BUILTINS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"] as const;
export const REMOTE_TOOL_ALIASES: Record<string, string> = Object.fromEntries(
  REMOTE_BUILTINS.map((n) => [n, `mcp__${REMOTE_MCP_NAME}__${n.toLowerCase()}`]),
);

const PREFIX = `mcp__${REMOTE_MCP_NAME}__`;
const READ_ONLY = new Set(["read", "glob", "grep", "bash_output"]);
const EDITS = new Set(["write", "edit"]);
const SHELL = new Set(["bash", "bash_kill"]);

export function builtinFor(toolName: string): string | null {
  if (!toolName.startsWith(PREFIX)) return null;
  const t = toolName.slice(PREFIX.length);
  if (SHELL.has(t)) return "Bash";
  const b = REMOTE_BUILTINS.find((n) => n.toLowerCase() === t);
  return b ?? null;
}

/** Mirror the SDK's own treatment of the built-in each remote tool replaces:
 *  read-only tools never prompt; plan mode denies changes; edits auto-allow in
 *  acceptEdits; shell asks unless bypassPermissions. null = not a remote tool
 *  (caller's normal path). */
export function remotePermission(toolName: string, mode: string): "allow" | "ask" | "deny" | null {
  if (!toolName.startsWith(PREFIX)) return null;
  const t = toolName.slice(PREFIX.length);
  if (READ_ONLY.has(t)) return "allow";
  if (mode === "plan") return "deny";
  if (mode === "bypassPermissions") return "allow";
  if (EDITS.has(t)) return mode === "acceptEdits" ? "allow" : "ask";
  return "ask";
}

export function makeRemoteCanUseTool(base: CanUseTool | undefined, getMode: () => string): CanUseTool {
  return async (toolName, input, ctx) => {
    const d = remotePermission(toolName, getMode());
    if (d === "allow") return { behavior: "allow", updatedInput: input };
    if (d === "deny") return { behavior: "deny", message: "Plan mode: no changes to the remote machine." };
    const name = d === "ask" ? builtinFor(toolName)! : toolName;
    if (!base) {
      return d === "ask"
        ? { behavior: "deny", message: "No approver is configured for remote shell/file changes." }
        : { behavior: "allow", updatedInput: input };
    }
    return base(name, input, ctx);
  };
}

/** Belt and braces for toolAliases: hooks see the post-alias name, so this fires
 *  only if something reaches a LOCAL built-in directly (spec §4.1). */
export const denyLocalBuiltins: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  if (!(REMOTE_BUILTINS as readonly string[]).includes((input as any).tool_name)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Remote mode is on: local file and shell tools are disabled for this thread.",
    },
  };
};

const GUIDANCE =
  "Stop and tell the user their machine is not reachable. They can check with `/remote`; if they restarted `tailcat serve` and got a new address, `/remote <new-address>` re-points this thread. Do not retry in a loop or work around it.";

function guarded<I>(name: string, fn: (i: I) => Promise<ToolText>) {
  return async (i: I): Promise<ToolText> => {
    const t = performance.now();
    try {
      const { exitCode, ...r } = await fn(i);
      audit(name, i, r.isError ? "error" : "ok", exitCode, t);
      return r;
    } catch (e) {
      audit(name, i, e instanceof RemoteError ? e.code : "exception", undefined, t);
      if (e instanceof RemoteError) return fail(`${e.message}\n${GUIDANCE}`);
      return fail(`remote ${name} failed: ${(e as Error).message}`);
    }
  };
}

/** One line per call (spec §4.6): tool, program name or path basename, exit code,
 *  duration. No content, no address. */
function audit(name: string, input: any, outcome: string, code: number | null | undefined, t0: number) {
  const subject = name === "bash"
    ? (String(input?.command ?? "").trim().split(/\s+/)[0] ?? "").split("/").pop()
    : String(input?.file_path ?? input?.path ?? input?.bash_id ?? input?.shell_id ?? "").split("/").pop();
  console.log(`[remote] tool=${name} subject=${subject || "-"} outcome=${outcome} code=${code === undefined ? "-" : code} ms=${Math.round(performance.now() - t0)}`);
}

export function createRemoteMcp(o: { exec: Exec; root: string; sessionKey: string }): McpSdkServerConfigWithInstance {
  const files = { exec: o.exec, root: o.root, state: new ReadState() };
  const shell = { exec: o.exec, root: o.root, sessionKey: o.sessionKey, cwd: { value: o.root }, bg: new Map<string, number>() };
  return createSdkMcpServer({
    name: REMOTE_MCP_NAME,
    version: "0.1.0",
    tools: [
      tool("bash", "Run a shell command on the user's machine (remote mode). Same contract as Bash.", {
        command: z.string(),
        timeout: z.number().optional(),
        description: z.string().optional(),
        run_in_background: z.boolean().optional(),
      }, guarded("bash", (i) => bashTool(shell, i))),
      tool("bash_output", "Read new output and status of a remote background job.", {
        bash_id: z.string(),
      }, guarded("bash_output", (i) => bashOutputTool(shell, i))),
      tool("bash_kill", "Stop a remote background job and its whole process group.", {
        shell_id: z.string(),
      }, guarded("bash_kill", (i) => bashKillTool(shell, i))),
      tool("read", "Read a file on the user's machine (remote mode). Same contract as Read.", {
        file_path: z.string(),
        offset: z.number().optional(),
        limit: z.number().optional(),
      }, guarded("read", (i) => readTool(files, i))),
      tool("write", "Write a file on the user's machine (remote mode). Same contract as Write.", {
        file_path: z.string(),
        content: z.string(),
      }, guarded("write", (i) => writeTool(files, i))),
      tool("edit", "Edit a file on the user's machine (remote mode). Same contract as Edit.", {
        file_path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      }, guarded("edit", (i) => editTool(files, i))),
      tool("glob", "Find files by glob on the user's machine (remote mode). Same contract as Glob.", {
        pattern: z.string(),
        path: z.string().optional(),
      }, guarded("glob", (i) => globTool(files, i))),
      tool("grep", "Search file contents on the user's machine (remote mode). Same contract as Grep.", {
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional(),
        type: z.string().optional(),
        output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
        "-i": z.boolean().optional(),
        "-n": z.boolean().optional(),
        "-A": z.number().optional(),
        "-B": z.number().optional(),
        "-C": z.number().optional(),
        head_limit: z.number().optional(),
        multiline: z.boolean().optional(),
      }, guarded("grep", (i) => grepTool(files, i))),
    ],
  });
}
```

**Gating sites (spec §4.6 enumeration)** — every place that matches tool names, and why remote parity holds:

| Site | What it matches | Remote parity |
|---|---|---|
| `src/gateway/slack/permission-gate.ts:47` `permissionPolicy` (gateway resolver + REST `openPermission`) | `SLAUDE_AUTO_ALLOW_TOOLS` names, `mcp__slaude_*` prefixes | `makeRemoteCanUseTool` calls the resolver with the **built-in** name (`Bash`/`Write`/`Edit`), so the policy sees exactly what it sees locally; pinned by the parity test above |
| `src/node/shims/permission.ts:26` node resolver | same `permissionPolicy`, then gateway `can_use_tool` | same renaming, same result |
| `src/gateway/slack/permission-gate.ts:144` approval card | raw input preview | card shows `Bash` + the command, as for a local call |
| `src/gateway/core/status-text.ts` / `manager.ts` `turnTools` / `AUTO_EVOLVE_IGNORE` | model-emitted `block.name` | model emits `Bash`/`Read`… (aliases resolve later), so unchanged |
| `src/knowledge/ingest.ts:118` | `Write`/`Edit` in a separate ingest query | not a remote session — untouched |
| SDK mode handling (`plan`, `acceptEdits`, `bypassPermissions`) | built-in names only | reproduced by `remotePermission` |

- [ ] **Step 4: Run tests**

Run: `bun test tests/remote/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/remote/mcp.ts tests/remote/mcp.test.ts
git commit -m "feat(remote): remote MCP server, tool aliases, local-builtin guard, permission parity"
```

---

### Task 8: Session-mode block for remote

**Files:**
- Modify: `src/agent/session-mode.ts`
- Test: `tests/agent/session-mode.test.ts` (extend)

**Interfaces:**
- Produces: `sessionModeBlock(lock: OneOnOneLockRow | null, remote?: { userId: string; dir: string } | null): string`

- [ ] **Step 1: Write the failing test** — append to `tests/agent/session-mode.test.ts`:

```ts
describe("sessionModeBlock with remote", () => {
  test("adds a <remote-mode> block naming the machine owner and dir", () => {
    const b = sessionModeBlock(lock("U123"), { userId: "U123", dir: "/home/u/repo" });
    expect(b).toContain("<session-mode>");
    expect(b).toContain("<remote-mode>");
    expect(b).toContain("<@U123>'s own machine");
    expect(b).toContain("`/home/u/repo`");
    expect(b).toContain("mcp__remote__bash_output");
    expect(b).toContain("REMOTE_UNREACHABLE");
  });
  test("no remote → unchanged output", () => {
    expect(sessionModeBlock(lock("U123"), null)).toBe(sessionModeBlock(lock("U123")));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/agent/session-mode.test.ts`
Expected: FAIL — `<remote-mode>` missing.

- [ ] **Step 3: Implement** — change the signature and append the block:

```ts
export function sessionModeBlock(
  lock: OneOnOneLockRow | null,
  remote?: { userId: string; dir: string } | null,
): string {
  const base = lockBlock(lock);
  if (!remote) return base;
  return [base, remoteBlock(remote)].filter(Boolean).join("\n\n");
}

function remoteBlock(r: { userId: string; dir: string }): string {
  return [
    "<remote-mode>",
    `Your file and shell tools (Bash, Read, Write, Edit, Glob, Grep) run on <@${r.userId}>'s own machine, in \`${r.dir}\` — not on this server.`,
    "Relative paths resolve against that directory. The knowledge base, MCP servers and web tools are unchanged and still run here.",
    "Background jobs: Bash with run_in_background returns an ID; read output with mcp__remote__bash_output and stop it with mcp__remote__bash_kill.",
    "If a tool fails with REMOTE_UNREACHABLE or REMOTE_AUTH_FAILED, stop and tell the user (they can check with `/remote`). Do not retry in a loop and do not work around it.",
    "</remote-mode>",
  ].join("\n");
}
```

Rename the existing function body to `function lockBlock(lock: OneOnOneLockRow | null): string { … }` (unchanged logic).

- [ ] **Step 4: Run tests**

Run: `bun test tests/agent/session-mode.test.ts`
Expected: PASS (old and new tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/session-mode.ts tests/agent/session-mode.test.ts
git commit -m "feat(remote): remote-mode block in the session system prompt"
```

---

### Task 9: `activeRemoteTarget`, pre-flight, and manager wiring

**Files:**
- Create: `src/remote/active.ts`, `src/remote/preflight.ts`
- Modify: `src/agent/manager.ts`
- Test: `tests/remote/active.test.ts`, `tests/agent/manager-remote.test.ts`

**Interfaces:**
- Consumes: Tasks 1–8
- Produces:
  - `activeRemoteTarget(channelId: string, threadTs: string): Promise<RemoteTarget | null>` — non-null only when a target exists **and** a lock exists, is locked (`open_scope === null`), and its `locked_user === target.user_id`.
  - `preflight(i: { addr: string; dir: string; privateKey: string }): Promise<{ ok: true; dir: string } | { ok: false; error: string }>`
  - `remoteCleanup(i: { addr: string; privateKey: string; sessionKey: string }): Promise<void>` (best-effort, never throws)
  - `AgentManager.setRemote(resolver: ((sessionId: string) => Promise<RemoteTarget | null>) | undefined, factory: ((sessionId: string, t: RemoteTarget) => Promise<RemoteHandle> | RemoteHandle) | undefined): void`
  - `AgentManager.ensureConfigFp(sessionId: string, fp: string | undefined): Promise<void>`
  - `LiveSession.mode: PermissionMode` (kept current by `setPermissionMode`)

- [ ] **Step 1: Write the failing test for `activeRemoteTarget`**

`tests/remote/active.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "bun:test";
import * as OneOnOne from "../../src/db/one-on-one";
import * as Remote from "../../src/db/remote";
import { activeRemoteTarget } from "../../src/remote/active";

beforeEach(async () => { await OneOnOne._wipeForTests(); await Remote._wipeForTests(); });

const target = (userId = "U_A") =>
  Remote.setTarget({ channelId: "C1", threadTs: "1.0", teamId: "T1", userId, addr: "tcA", dir: "/r", lockByRemote: true });

describe("activeRemoteTarget", () => {
  it("is null without a target", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    expect(await activeRemoteTarget("C1", "1.0")).toBeNull();
  });
  it("is null without a lock (no lock, no remote)", async () => {
    await target();
    expect(await activeRemoteTarget("C1", "1.0")).toBeNull();
  });
  it("is null when the lock is open to guests", async () => {
    await target();
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    await OneOnOne.setOpen("C1", "1.0", "");
    expect(await activeRemoteTarget("C1", "1.0")).toBeNull();
  });
  it("is null when the lock belongs to someone else", async () => {
    await target("U_A");
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_MGR", createdBy: "U_MGR" });
    expect(await activeRemoteTarget("C1", "1.0")).toBeNull();
  });
  it("returns the target when locked to its owner", async () => {
    await target();
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    expect(await activeRemoteTarget("C1", "1.0")).toEqual({ teamId: "T1", userId: "U_A", addr: "tcA", dir: "/r" });
  });
});
```

- [ ] **Step 2: Implement `active.ts` and `preflight.ts`**

`src/remote/active.ts`:

```ts
import * as OneOnOne from "../db/one-on-one";
import * as Remote from "../db/remote";
import type { RemoteTarget } from "./types";

/** The thread's remote target, only while the invariant holds: a LOCKED 1on1
 *  owned by the target's user. Anything else means "run locally". */
export async function activeRemoteTarget(channelId: string, threadTs: string): Promise<RemoteTarget | null> {
  const [t, lock] = await Promise.all([Remote.findTarget(channelId, threadTs), OneOnOne.find(channelId, threadTs)]);
  if (!t || !lock || lock.open_scope !== null || lock.locked_user !== t.user_id) return null;
  return { teamId: t.team_id, userId: t.user_id, addr: t.addr, dir: t.dir };
}
```

`src/remote/preflight.ts`:

```ts
import { RemoteConn } from "./conn";
import { shq } from "./shell";
import { tailcatSocket } from "./tailcat";
import { RemoteError } from "./types";

/** Connect once and resolve the directory. Nothing is stored unless this succeeds. */
export async function preflight(i: { addr: string; dir: string; privateKey: string }): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  let conn: RemoteConn;
  try {
    conn = new RemoteConn({ socket: tailcatSocket(i.addr), privateKey: i.privateKey, reconnectDelayMs: 0, readyTimeoutMs: 20_000 });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  try {
    const cd = i.dir === "~" ? `cd "$HOME"` : i.dir.startsWith("~/") ? `cd "$HOME"/${shq(i.dir.slice(2))}` : `cd ${shq(i.dir)}`;
    const r = await conn.exec(`${cd} && pwd -P`, { timeoutMs: 20_000 });
    if (r.code !== 0) return { ok: false, error: `directory not found or not accessible: ${i.dir}` };
    return { ok: true, dir: r.stdout.trim() };
  } catch (e) {
    return { ok: false, error: e instanceof RemoteError ? e.message : String((e as Error).message ?? e) };
  } finally {
    conn.close();
  }
}

/** Best-effort: kill a session's background jobs on the remote when remote mode
 *  ends (spec §5.2). Runs from the gateway so it works in split deploys even if
 *  no further turn ever reaches a node. Never throws. */
export async function remoteCleanup(i: { addr: string; privateKey: string; sessionKey: string }): Promise<void> {
  let conn: RemoteConn | undefined;
  try {
    conn = new RemoteConn({ socket: tailcatSocket(i.addr), privateKey: i.privateKey, reconnectDelayMs: 0, readyTimeoutMs: 15_000 });
    await conn.exec(cleanupCommand(i.sessionKey), { timeoutMs: 30_000 });
  } catch (e) {
    console.error(`[remote] cleanup skipped: ${e instanceof RemoteError ? e.code : "error"}`);
  } finally {
    conn?.close();
  }
}
```

(add `import { cleanupCommand } from "./tools/bash";` to `preflight.ts`.)

Run: `bun test tests/remote/active.test.ts` → PASS.

- [ ] **Step 3: Write the failing manager test**

`tests/agent/manager-remote.test.ts` — copy the SDK-stub preamble **verbatim** from `tests/agent/manager-lifecycle.test.ts` lines 11–195 (env defaults, `mock.module`, `FakeSession`, `dispatcher`, `plan`, `until`, `thread()`, `record()`, `shutdown`, `beforeEach`/`afterAll`), then add:

```ts
describe("remote wiring", () => {
  it("with a target: remote MCP server, aliases, PreToolUse guard, remote mode block", async () => {
    const mgr = new AgentManager();
    mgr.setRemote(
      async () => ({ teamId: "T1", userId: "U_A", addr: "tcA", dir: "/home/a/repo" }),
      () => ({ exec: async () => ({ stdout: "", stderr: "", code: 0, truncated: false, timedOut: false }), release: async () => {}, dispose: async () => {} }),
    );
    const row = await mgr.ensureSession(thread());
    const fs = plan();
    await mgr.sendMessage(row.id, "hello");
    await until(() => fs.options !== null, 3000, "boot");
    expect(fs.options.mcpServers.remote).toBeDefined();
    expect(fs.options.toolAliases.Bash).toBe("mcp__remote__bash");
    expect(fs.options.hooks.PreToolUse).toHaveLength(1);
    expect(fs.options.systemPrompt.append).toContain("<remote-mode>");
    expect(fs.options.disallowedTools ?? []).not.toContain("Bash"); // enabled + alias (spike §8)
    await shutdown(mgr, row.id);
  });

  it("a reboot releases but keeps the handle (jobs survive); a changed or ended target disposes it", async () => {
    const mgr = new AgentManager();
    let target: any = { teamId: "T1", userId: "U_A", addr: "tcA", dir: "/r" };
    const log: string[] = [];
    let opened = 0;
    mgr.setRemote(async () => target, () => {
      const n = ++opened;
      return {
        exec: async () => ({ stdout: "", stderr: "", code: 0, truncated: false, timedOut: false }),
        release: async () => { log.push(`release${n}`); },
        dispose: async () => { log.push(`dispose${n}`); },
      };
    });
    const row = await mgr.ensureSession(thread());
    const boot = async () => { const fs = plan(); await mgr.sendMessage(row.id, "hi"); await until(() => fs.options !== null, 3000, "boot"); await shutdown(mgr, row.id); };
    await boot();                       // open #1
    await boot();                       // same target: reuse #1
    expect(opened).toBe(1);
    expect(log.filter((l) => l.startsWith("dispose"))).toEqual([]);
    target = { ...target, addr: "tcB" }; // re-pointed
    await boot();
    expect(log).toContain("dispose1");
    expect(opened).toBe(2);
    target = null;                      // /remote off
    await boot();
    expect(log).toContain("dispose2");
  });

  it("without a target: no remote server, no aliases, no guard", async () => {
    const mgr = new AgentManager();
    mgr.setRemote(async () => null, () => { throw new Error("factory must not run"); });
    const row = await mgr.ensureSession(thread());
    const fs = plan();
    await mgr.sendMessage(row.id, "hello");
    await until(() => fs.options !== null, 3000, "boot");
    expect(fs.options.mcpServers?.remote).toBeUndefined();
    expect(fs.options.toolAliases).toBeUndefined();
    expect(fs.options.hooks.PreToolUse).toBeUndefined();
    await shutdown(mgr, row.id);
  });

  it("canUseTool: remote read allowed without asking; remote bash asks as Bash; follows /mode changes", async () => {
    const mgr = new AgentManager();
    const asked: string[] = [];
    mgr.setPermissionResolver(async (_sid, toolName, input) => { asked.push(toolName); return { behavior: "allow", updatedInput: input } as any; });
    mgr.setRemote(async () => ({ teamId: "T1", userId: "U_A", addr: "tcA", dir: "/r" }), () => ({ exec: async () => ({ stdout: "", stderr: "", code: 0, truncated: false, timedOut: false }), release: async () => {}, dispose: async () => {} }));
    const row = await mgr.ensureSession(thread());
    const fs = plan();
    await mgr.sendMessage(row.id, "hello");
    await until(() => fs.options !== null, 3000, "boot");
    const sig = { signal: new AbortController().signal };
    expect((await fs.options.canUseTool("mcp__remote__read", { file_path: "a" }, sig)).behavior).toBe("allow");
    await fs.options.canUseTool("mcp__remote__bash", { command: "ls" }, sig);
    expect(asked).toEqual(["Bash"]);
    await mgr.setPermissionMode(row.id, "bypassPermissions");
    await fs.options.canUseTool("mcp__remote__bash", { command: "ls" }, sig);
    expect(asked).toEqual(["Bash"]); // bypass: no second ask
    await shutdown(mgr, row.id);
  });

  it("ensureConfigFp: first sight records; a change reloads the warm session; same fp is a no-op", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const fs = plan();
    await mgr.ensureConfigFp(row.id, "fp1");
    await mgr.sendMessage(row.id, "hello");
    await until(() => fs.options !== null, 3000, "boot");
    await mgr.ensureConfigFp(row.id, "fp1");
    expect(mgr.isLive(row.id)).toBe(true);
    await mgr.ensureConfigFp(row.id, "fp2");
    expect(mgr.isLive(row.id)).toBe(false);
    await mgr.ensureConfigFp(row.id, undefined); // tokens from an older gateway: ignored
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `bun test tests/agent/manager-remote.test.ts`
Expected: FAIL — `mgr.setRemote is not a function`.

- [ ] **Step 5: Implement in `src/agent/manager.ts`**

Imports (top of file, beside the other `./` imports):

```ts
import { REMOTE_MCP_NAME, REMOTE_TOOL_ALIASES, createRemoteMcp, denyLocalBuiltins, makeRemoteCanUseTool } from "../remote/mcp";
import type { RemoteHandle, RemoteTarget } from "../remote/types";
```

`LiveSession` — add a field:

```ts
  /** Current permission mode (kept in sync by setPermissionMode) — remote tool gating reads it. */
  mode?: PermissionMode;
```

Fields (after `#stopGuard`):

```ts
  #remoteResolver: ((sessionId: string) => Promise<RemoteTarget | null>) | undefined;
  #remoteFactory: ((sessionId: string, t: RemoteTarget) => Promise<RemoteHandle> | RemoteHandle) | undefined;
  /** Per session: the open remote handle and the target it was opened for.
   *  Survives reboots (jobs keep running); disposed only when the target ends/changes. */
  #remoteHandles = new Map<string, { handle: RemoteHandle; key: string }>();
  /** Latest session-config fingerprint seen per session (node: from job claims). */
  #configFp = new Map<string, string>();
```

Setters (after `setStopGuard`):

```ts
  /** Remote mode (spec §4.1): resolver says whether a session's tools run remotely;
   *  factory opens the connection handle for a session that does. */
  setRemote(
    resolver: ((sessionId: string) => Promise<RemoteTarget | null>) | undefined,
    factory: ((sessionId: string, t: RemoteTarget) => Promise<RemoteHandle> | RemoteHandle) | undefined,
  ) {
    this.#remoteResolver = resolver;
    this.#remoteFactory = factory;
  }

  /** Reboot a warm session whose lock/remote config changed since it booted
   *  (spec §4.4). First sight only records; undefined (older gateway) is ignored. */
  async ensureConfigFp(sessionId: string, fp: string | undefined): Promise<void> {
    if (fp === undefined) return;
    const prev = this.#configFp.get(sessionId);
    this.#configFp.set(sessionId, fp);
    if (prev === undefined || prev === fp) return;
    if (!this.reload(sessionId)) return;
    const deadline = Date.now() + 10_000;
    while (this.isLive(sessionId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  }

  /** Reuse the session's handle when the target is unchanged; otherwise dispose
   *  the old one (kills its background jobs — remote ended or moved) and open anew. */
  async #remoteHandleFor(sessionId: string, target: RemoteTarget | null): Promise<RemoteHandle | undefined> {
    const key = target ? `${target.userId}|${target.addr}|${target.dir}` : "";
    const prev = this.#remoteHandles.get(sessionId);
    if (prev && prev.key === key) return prev.handle;
    if (prev) {
      this.#remoteHandles.delete(sessionId);
      try { await prev.handle.dispose(); } catch (e) { console.error(`[mgr] remote dispose failed session=${sessionId}:`, e); }
    }
    if (!target || !this.#remoteFactory) return undefined;
    const handle = await this.#remoteFactory(sessionId, target);
    this.#remoteHandles.set(sessionId, { handle, key });
    return handle;
  }
```

`setPermissionMode` — after `await this.#store.setPermissionMode(sessionId, mode);` and the `const live = …` line, add:

```ts
    if (live) live.mode = mode;
```

`#startSession` — directly after `const mcpServers = await this.#mcpResolver?.(sessionId);` (line ~585):

```ts
    // Remote mode: tools for this session run on the lock owner's machine.
    const remoteTarget = this.#remoteResolver ? await this.#remoteResolver(sessionId) : null;
    const remoteHandle = await this.#remoteHandleFor(sessionId, remoteTarget);
```

Replace the `canUseTool` construction (lines 579–582) so it runs **after** the block above (move it down) and wraps for remote:

```ts
    const resolver = this.#resolver;
    const baseCanUse: CanUseTool | undefined = resolver
      ? (toolName, input, ctx) => resolver(sessionId, toolName, input, ctx)
      : undefined;
    const canUseTool: CanUseTool | undefined = remoteHandle
      ? makeRemoteCanUseTool(baseCanUse, () => this.#live.get(sessionId)?.mode ?? mode)
      : baseCanUse;
```

(`mode` is the existing `const mode = (row.permission_mode || "default") as PermissionMode;` at line ~584, which sits above this block.)

`mergedMcpServers` — add the remote server:

```ts
    const mergedMcpServers = {
      ...(mcpServers ?? {}),
      ...pluginMcps,
      ...(remoteHandle && remoteTarget
        ? { [REMOTE_MCP_NAME]: createRemoteMcp({ exec: remoteHandle.exec, root: remoteTarget.dir, sessionKey: sessionId }) }
        : {}),
    };
```

`options` — add after `plugins: allPlugins,`:

```ts
      ...(remoteHandle ? { toolAliases: REMOTE_TOOL_ALIASES } : {}),
```

and replace the `hooks` literal with:

```ts
      hooks: {
        PreCompact: [{ hooks: [preCompact] }],
        Stop: [{ hooks: [stopHook] }],
        UserPromptSubmit: [{ hooks: [userPromptHook] }],
        ...(remoteHandle ? { PreToolUse: [{ hooks: [denyLocalBuiltins] }] } : {}),
      },
```

and change `sessionModeBlock(lock),` to:

```ts
          sessionModeBlock(lock, remoteTarget ? { userId: remoteTarget.userId, dir: remoteTarget.dir } : null),
```

`live` object literal (line ~704) — add `mode,`.

`finally` block (line ~778) — after `this.#live.delete(sessionId);`. Release the connection only: a reboot (reload, `stream_closed`, idle TTL, `/mcp connect`) must not kill the user's background jobs (spec §5.2 cleanup happens when remote ends — `/remote off`, see Task 10, or a changed target at next boot):

```ts
        void this.#remoteHandles.get(sessionId)?.handle.release().catch((e) =>
          console.error(`[mgr] remote release failed session=${sessionId}:`, e));
```

- [ ] **Step 6: Run tests**

Run: `bun test tests/agent/manager-remote.test.ts tests/agent/manager-lifecycle.test.ts tests/agent/session-mode.test.ts tests/remote/`
Expected: PASS (existing lifecycle tests unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/remote/active.ts src/remote/preflight.ts src/agent/manager.ts tests/remote/active.test.ts tests/agent/manager-remote.test.ts
git commit -m "feat(remote): boot remote sessions with aliased tools, guard, and config-fingerprint reload"
```

---

### Task 10: `/remote` command — parse, handler, gateway wiring, `/1on1` invariants

**Files:**
- Modify: `src/gateway/slack/commands.ts`
- Create: `src/gateway/core/remote-command.ts`
- Modify: `src/gateway/core/gateway.ts`
- Modify: `src/gateway/core/status-text.ts`
- Test: `tests/gateway/slack/commands-remote.test.ts`, `tests/gateway/core/remote-command.test.ts`, extend `tests/commands.test.ts`

**Interfaces:**
- Consumes: Tasks 1–9
- Produces:
  - `SlashHit` variants: `{ kind: "remote"; action: "on"; addr: string; dir?: string } | { kind: "remote"; action: "off" | "status" | "key" }`
  - `handleRemoteCommand(hit, ctx: RemoteCommandCtx, deps?: RemoteCommandDeps): Promise<void>`
  - `interface RemoteCommandCtx { teamId; channelId; threadTs; userId; sessionId: string; isManager: boolean; reply(t: string): Promise<void>; sayPrivately(t: string): Promise<void>; reload(): void }`
  - `interface RemoteCommandDeps { preflight: typeof preflight; ping: typeof tailcatPing; cleanup: typeof remoteCleanup; generateKeyPair(comment: string): { privateKey: string; publicKey: string } }`
  - `endRemoteForThread(channelId, threadTs, opts?: { sessionId?: string; cleanup?: typeof remoteCleanup }): Promise<{ ended: boolean; lockByRemote: boolean }>` — clears the target, starts best-effort job cleanup when `sessionId` is given (not awaited), and reports whether `/remote` had created the lock; it never unlocks by itself (callers decide: `/remote off` unlocks when `lockByRemote`, `/1on1 off` unlocks anyway)
  - `humanizeToolStatus(tool, input, opts?: { remote?: boolean })`

- [ ] **Step 1: Write the failing parse test**

`tests/gateway/slack/commands-remote.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { parseSlashCommand, AGENT_COMMANDS } from "../../../src/gateway/slack/commands";

describe("/remote parsing", () => {
  it("bare → status", () => expect(parseSlashCommand("/remote")).toEqual({ kind: "remote", action: "status" }));
  it("off / key / status", () => {
    expect(parseSlashCommand("/remote off")).toEqual({ kind: "remote", action: "off" });
    expect(parseSlashCommand("/remote key")).toEqual({ kind: "remote", action: "key" });
    expect(parseSlashCommand("/remote status")).toEqual({ kind: "remote", action: "status" });
  });
  it("addr + dir (dir may contain spaces), case preserved", () => {
    expect(parseSlashCommand("/remote tcAbC_9 /Users/x/My Repo")).toEqual({ kind: "remote", action: "on", addr: "tcAbC_9", dir: "/Users/x/My Repo" });
  });
  it("addr alone keeps the stored dir", () => {
    expect(parseSlashCommand("/remote tcAbC_9")).toEqual({ kind: "remote", action: "on", addr: "tcAbC_9" });
  });
  it("is listed in help", () => {
    expect(AGENT_COMMANDS.map((c) => c.usage).join(" ")).toContain("/remote");
  });
});
```

- [ ] **Step 2: Implement parsing**

In `src/gateway/slack/commands.ts`:
- Add to `SlashHit` (after the `one-on-one` variants):
  ```ts
  | { kind: "remote"; action: "on"; addr: string; dir?: string }
  | { kind: "remote"; action: "off" | "status" | "key" }
  ```
- Add to `AGENT_COMMANDS` right after the `/1on1` entry:
  ```ts
  { usage: "/remote [<addr> [dir] | off | key]", summary: "run this thread's shell + file tools on your own machine over tailcat (locks the thread to you); no arg shows status" },
  ```
- Add to `parseSlashCommand` right after the `/1on1` branch. Use the raw, case-preserving remainder of the input for the dir — reconstruct it from the original text, not from lower-cased tokens:
  ```ts
  if (cmd === "remote") {
    const sub = (rest[0] ?? "").toLowerCase();
    if (!rest[0] || sub === "status") return { kind: "remote", action: "status" };
    if (sub === "off") return { kind: "remote", action: "off" };
    if (sub === "key") return { kind: "remote", action: "key" };
    const dir = rest.slice(1).join(" ").trim();
    return dir ? { kind: "remote", action: "on", addr: rest[0], dir } : { kind: "remote", action: "on", addr: rest[0] };
  }
  ```
  Check how `rest` is built at the top of `parseSlashCommand`: if it splits on runs of whitespace, a dir containing double spaces would be altered — acceptable (documented in the guide), paths with single spaces round-trip as the test requires. If `rest` is lower-cased anywhere, take the tokens from the original string instead (the `/model` branch comment says ids are case-preserved, so it is not).

Run: `bun test tests/gateway/slack/commands-remote.test.ts tests/commands.test.ts` → PASS.

- [ ] **Step 3: Write the failing handler test**

`tests/gateway/core/remote-command.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as OneOnOne from "../../../src/db/one-on-one";
import * as Remote from "../../../src/db/remote";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { handleRemoteCommand, endRemoteForThread, type RemoteCommandDeps } from "../../../src/gateway/core/remote-command";

let replies: string[], privately: string[], reloads: number, preflights: any[], cleanups: any[];
const ctx = (over: Partial<{ userId: string; isManager: boolean }> = {}) => ({
  teamId: "T1", channelId: "C1", threadTs: "1.0", userId: over.userId ?? "U_A", sessionId: "S1", isManager: over.isManager ?? false,
  reply: async (t: string) => { replies.push(t); },
  sayPrivately: async (t: string) => { privately.push(t); },
  reload: () => { reloads++; },
});
const deps = (ok = true): RemoteCommandDeps => ({
  preflight: async (i) => { preflights.push(i); return ok ? { ok: true, dir: "/abs/repo" } : { ok: false, error: "REMOTE_UNREACHABLE: no route" }; },
  ping: async () => "direct",
  cleanup: async (i) => { cleanups.push(i); },
  generateKeyPair: (c) => ({ privateKey: `PRIV-${c}`, publicKey: `ssh-ed25519 AAAA ${c}` }),
});
const allOut = () => [...replies, ...privately].join("\n");

beforeEach(async () => {
  process.env.SLAUDE_REMOTE = "1";
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
  __resetMasterKeyCache();
  await OneOnOne._wipeForTests();
  await Remote._wipeForTests();
  replies = []; privately = []; reloads = 0; preflights = []; cleanups = [];
});
afterEach(() => { delete process.env.SLAUDE_REMOTE; });

describe("/remote", () => {
  it("flag off → disabled reply, nothing stored", async () => {
    delete process.env.SLAUDE_REMOTE;
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx(), deps());
    expect(replies[0]).toContain("not enabled");
    expect(await Remote.findTarget("C1", "1.0")).toBeNull();
  });

  it("first use without a key: generates one, sends setup privately, stores no target", async () => {
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx(), deps());
    expect(privately[0]).toContain("tailcat serve");
    expect(privately[0]).toContain("ssh-ed25519 AAAA");
    expect(await Remote.getKey("T1", "U_A")).not.toBeNull();
    expect(await Remote.findTarget("C1", "1.0")).toBeNull();
    expect(preflights).toHaveLength(0);
  });

  it("with a key: preflight, auto-lock, store the RESOLVED dir, reload; never echoes the address", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcSecretAddr", dir: "~/repo" }, ctx(), deps());
    expect(preflights[0]).toEqual({ addr: "tcSecretAddr", dir: "~/repo", privateKey: "PRIV" });
    const t = await Remote.findTarget("C1", "1.0");
    expect(t?.dir).toBe("/abs/repo");
    expect(t?.lock_by_remote).toBe(1);
    expect((await OneOnOne.find("C1", "1.0"))?.locked_user).toBe("U_A");
    expect(reloads).toBe(1);
    expect(allOut()).not.toContain("tcSecretAddr");
  });

  it("failed preflight: reply with reason, no lock, no target, no reload", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx(), deps(false));
    expect(replies[0]).toContain("REMOTE_UNREACHABLE");
    expect(await OneOnOne.find("C1", "1.0")).toBeNull();
    expect(await Remote.findTarget("C1", "1.0")).toBeNull();
    expect(reloads).toBe(0);
  });

  it("rejects a flag-looking address and a relative dir before connecting", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "--serve", dir: "/r" }, ctx(), deps());
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "repo" }, ctx(), deps());
    expect(preflights).toHaveLength(0);
    expect(replies.join("\n")).toContain("address");
    expect(replies.join("\n")).toContain("absolute");
  });

  it("a manager cannot point someone else's locked thread at the manager's machine", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    await Remote.putKeyIfAbsent("T1", "U_MGR", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx({ userId: "U_MGR", isManager: true }), deps());
    expect(replies[0]).toContain("owner");
    expect(await Remote.findTarget("C1", "1.0")).toBeNull();
  });

  it("refuses while the 1on1 is open to guests", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    await OneOnOne.setOpen("C1", "1.0", "");
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx(), deps());
    expect(replies[0]).toContain("/1on1 lock");
  });

  it("existing lock is kept on off (lock_by_remote = 0)", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx(), deps());
    await handleRemoteCommand({ kind: "remote", action: "off" }, ctx(), deps());
    expect(await OneOnOne.find("C1", "1.0")).not.toBeNull();
    expect(await Remote.findTarget("C1", "1.0")).toBeNull();
    expect(reloads).toBe(2);
  });

  it("off releases a lock that /remote created and cleans up the session's jobs", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx(), deps());
    await handleRemoteCommand({ kind: "remote", action: "off" }, ctx(), deps());
    expect(await OneOnOne.find("C1", "1.0")).toBeNull();
    await Bun.sleep(0);
    expect(cleanups).toEqual([{ addr: "tcAddr1", privateKey: "PRIV", sessionKey: "S1" }]);
  });

  it("a stale row from another user never makes this user's lock look /remote-created", async () => {
    // U_A's leftover target (lock_by_remote=1) remains after the lock moved to U_B.
    await Remote.setTarget({ channelId: "C1", threadTs: "1.0", teamId: "T1", userId: "U_A", addr: "tcOld", dir: "/r", lockByRemote: true });
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_B", createdBy: "U_B" });
    await Remote.putKeyIfAbsent("T1", "U_B", { privateKey: "PRIV-B", publicKey: "PUB-B" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx({ userId: "U_B" }), deps());
    expect((await Remote.findTarget("C1", "1.0"))?.lock_by_remote).toBe(0);
    await handleRemoteCommand({ kind: "remote", action: "off" }, ctx({ userId: "U_B" }), deps());
    expect((await OneOnOne.find("C1", "1.0"))?.locked_user).toBe("U_B");
  });

  it("re-point with address only keeps the stored dir", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx(), deps());
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr2" }, ctx(), deps());
    expect(preflights[1]).toEqual({ addr: "tcAddr2", dir: "/abs/repo", privateKey: "PRIV" });
    expect((await Remote.findTarget("C1", "1.0"))?.addr).toBe("tcAddr2");
  });

  it("status shows on/off and path, never the address", async () => {
    await handleRemoteCommand({ kind: "remote", action: "status" }, ctx(), deps());
    expect(replies[0]).toContain("off");
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcSecretAddr", dir: "/r" }, ctx(), deps());
    await handleRemoteCommand({ kind: "remote", action: "status" }, ctx(), deps());
    expect(replies.at(-1)).toContain("direct");
    expect(replies.at(-1)).toContain("/abs/repo");
    expect(allOut()).not.toContain("tcSecretAddr");
  });

  it("key re-sends the public key privately", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "ssh-ed25519 KEEP" });
    await handleRemoteCommand({ kind: "remote", action: "key" }, ctx(), deps());
    expect(privately[0]).toContain("ssh-ed25519 KEEP");
    expect(replies.join("")).not.toContain("KEEP");
  });

  it("endRemoteForThread clears the target, cleans up when given a session, and reports lock origin", async () => {
    await Remote.setTarget({ channelId: "C1", threadTs: "1.0", teamId: "T1", userId: "U_A", addr: "tcA", dir: "/r", lockByRemote: true });
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    const seen: any[] = [];
    expect(await endRemoteForThread("C1", "1.0", { sessionId: "S9", cleanup: async (i) => { seen.push(i); } })).toEqual({ ended: true, lockByRemote: true });
    expect(seen).toEqual([{ addr: "tcA", privateKey: "PRIV", sessionKey: "S9" }]);
    expect(await endRemoteForThread("C1", "1.0")).toEqual({ ended: false, lockByRemote: false });
  });
});
```

- [ ] **Step 4: Implement `remote-command.ts`**

```ts
import { utils } from "ssh2";
import { env } from "../../config/env";
import * as OneOnOne from "../../db/one-on-one";
import * as Remote from "../../db/remote";
import { preflight, remoteCleanup } from "../../remote/preflight";
import { isRemoteDir, isTailcatAddr } from "../../remote/shell";
import { tailcatPing } from "../../remote/tailcat";
import type { SlashHit } from "../slack/commands";

type RemoteHit = Extract<SlashHit, { kind: "remote" }>;

export interface RemoteCommandCtx {
  teamId: string;
  channelId: string;
  threadTs: string;
  userId: string;
  /** The thread's session id — the key of its remote background-job directory. */
  sessionId: string;
  isManager: boolean;
  reply(text: string): Promise<void>;
  sayPrivately(text: string): Promise<void>;
  reload(): void;
}

export interface RemoteCommandDeps {
  preflight: typeof preflight;
  ping: typeof tailcatPing;
  cleanup: typeof remoteCleanup;
  generateKeyPair(comment: string): { privateKey: string; publicKey: string };
}

const defaultDeps: RemoteCommandDeps = {
  preflight,
  ping: tailcatPing,
  cleanup: remoteCleanup,
  generateKeyPair: (comment) => {
    const k = utils.generateKeyPairSync("ed25519", { comment });
    return { privateKey: k.private, publicKey: k.public };
  },
};

function setupText(publicKey: string): string {
  return [
    "*Set up `/remote` on your machine* (only you can see this):",
    "1. Install tailcat: https://github.com/tailscale/tailcat",
    "2. Once, for an address that survives restarts: `tailcat genkey --key=default`",
    "3. Start the server (keep it running):",
    "```",
    `tailcat serve --key=default --ssh-authorized-keys="${publicKey.trim()}" ssh`,
    "```",
    "4. In the thread: `/remote <the address it prints> <directory>`",
    "",
    ":warning: Commands run as the account that runs `tailcat serve`, with everything that account can reach. Use a separate account or a container for repos you don't trust.",
  ].join("\n");
}

/** Clear the thread's remote target. With a sessionId, also start best-effort
 *  cleanup of that session's background jobs on the remote (not awaited: the
 *  laptop may be asleep). `lockByRemote` tells the caller whether /remote had
 *  created the lock. */
export async function endRemoteForThread(
  channelId: string,
  threadTs: string,
  opts: { sessionId?: string; cleanup?: typeof remoteCleanup } = {},
): Promise<{ ended: boolean; lockByRemote: boolean }> {
  const gone = await Remote.clearTarget(channelId, threadTs);
  if (gone && opts.sessionId) {
    const key = await Remote.getKey(gone.team_id, gone.user_id);
    if (key) void (opts.cleanup ?? remoteCleanup)({ addr: gone.addr, privateKey: key.privateKey, sessionKey: opts.sessionId });
  }
  return { ended: !!gone, lockByRemote: gone?.lock_by_remote === 1 };
}

export async function handleRemoteCommand(hit: RemoteHit, ctx: RemoteCommandCtx, deps: RemoteCommandDeps = defaultDeps): Promise<void> {
  if (!env.remote.enabled()) {
    await ctx.reply(":no_entry: `/remote` is not enabled on this deployment.");
    return;
  }
  const { channelId, threadTs, teamId, userId } = ctx;

  if (hit.action === "status") {
    const t = await Remote.findTarget(channelId, threadTs);
    if (!t) {
      await ctx.reply("Remote mode: *off* — tools run on the server.");
      return;
    }
    const path = await deps.ping(t.addr);
    await ctx.reply(`Remote mode: *on* — <@${t.user_id}>'s machine, \`${t.dir}\`, path: *${path}*.`);
    return;
  }

  if (hit.action === "key") {
    const key = (await Remote.getKey(teamId, userId)) ?? (await Remote.putKeyIfAbsent(teamId, userId, deps.generateKeyPair(`slaude:${userId}`)));
    await ctx.sayPrivately(setupText(key.publicKey));
    await ctx.reply("Sent you the `/remote` setup privately.");
    return;
  }

  if (hit.action === "off") {
    const t = await Remote.findTarget(channelId, threadTs);
    if (!t) {
      await ctx.reply("Remote mode is not on in this thread.");
      return;
    }
    if (t.user_id !== userId && !ctx.isManager) {
      await ctx.reply(`Only <@${t.user_id}> or the manager can turn remote mode off.`);
      return;
    }
    const { lockByRemote } = await endRemoteForThread(channelId, threadTs, { sessionId: ctx.sessionId, cleanup: deps.cleanup });
    if (lockByRemote) await OneOnOne.unlock(channelId, threadTs);
    ctx.reload();
    await ctx.reply(`:house: Remote mode *off* — tools run on the server again.${lockByRemote ? " 1on1 released." : ""}`);
    return;
  }

  // action === "on"
  if (!isTailcatAddr(hit.addr)) {
    await ctx.reply(":x: That doesn't look like a tailcat address.");
    return;
  }
  const lock = await OneOnOne.find(channelId, threadTs);
  if (lock && lock.locked_user !== userId) {
    await ctx.reply(`:lock: This thread is a 1on1 with <@${lock.locked_user}>; only its owner can use \`/remote\` here.`);
    return;
  }
  if (lock && lock.open_scope !== null) {
    await ctx.reply(":lock: This 1on1 is open to guests. Run `/1on1 lock` first — remote mode needs the thread locked to you.");
    return;
  }
  const existing = await Remote.findTarget(channelId, threadTs);
  const dir = hit.dir ?? (existing?.user_id === userId ? existing.dir : undefined);
  if (!dir) {
    await ctx.reply("Usage: `/remote <tailcat-address> <directory>`");
    return;
  }
  if (!isRemoteDir(dir)) {
    await ctx.reply(":x: The directory must be an absolute path or start with `~/`.");
    return;
  }
  const key = await Remote.getKey(teamId, userId);
  if (!key) {
    const fresh = await Remote.putKeyIfAbsent(teamId, userId, deps.generateKeyPair(`slaude:${userId}`));
    await ctx.sayPrivately(setupText(fresh.publicKey));
    await ctx.reply("First time here — I sent you setup steps privately. Run them, then `/remote <address> <directory>` again.");
    return;
  }
  const pf = await deps.preflight({ addr: hit.addr, dir, privateKey: key.privateKey });
  if (!pf.ok) {
    await ctx.reply(`:x: Couldn't use your machine: ${pf.error}`);
    return;
  }
  // Inherit "we created the lock" only from this user's own row: a stale row from
  // someone else must never make another person's lock releasable by /remote off.
  let lockByRemote = existing?.user_id === userId && existing.lock_by_remote === 1;
  if (!lock) {
    await OneOnOne.lock({ channelId, threadTs, lockedUser: userId, createdBy: userId });
    lockByRemote = true;
  }
  await Remote.setTarget({ channelId, threadTs, teamId, userId, addr: hit.addr, dir: pf.dir, lockByRemote });
  ctx.reload();
  await ctx.reply(`:satellite: Remote mode *on* — my shell and file tools now run on <@${userId}>'s machine in \`${pf.dir}\`. The thread is locked to you. \`/remote off\` to switch back.`);
}
```

Run: `bun test tests/gateway/core/remote-command.test.ts` → PASS.

- [ ] **Step 5: Wire into `gateway.ts`**

Imports (with the other db/core imports):

```ts
import * as Remote from "../../db/remote";
import { handleRemoteCommand, endRemoteForThread } from "./remote-command";
import { activeRemoteTarget } from "../../remote/active";
import { HelperClient } from "../../remote/helper-client";
import { cleanupCommand } from "../../remote/tools/bash";
```

(a) Slash dispatch — add before the `if (slash.kind === "one-on-one")` block, reusing the `/link` ephemeral pattern:

```ts
      if (slash.kind === "remote") {
        const remoteSurface = surfaceFactoryFor(dispatch?.personaId)({
          conversationId: channelId, threadRef: threadTs, inboundRef: threadTs, userId, teamId,
          requestApproval: async () => { throw new Error("approval is not part of /remote"); },
          reloadSession: () => false,
        });
        const soul = soulData();
        await handleRemoteCommand(slash, {
          teamId, channelId, threadTs, userId, sessionId: session.id,
          isManager: userId === soul.manager.userId || userId === soul.backupManager.userId,
          reply,
          sayPrivately: async (text) => {
            if (remoteSurface.capabilities.has("ephemeral") && remoteSurface.sayEphemeral) {
              await remoteSurface.sayEphemeral({ text, userId });
              return;
            }
            await reply(":warning: `/remote` setup needs a surface that supports private replies.");
          },
          reload: () => { agent.reload(session.id); },
        });
        return;
      }
```

(b) `/1on1` invariants — every path that ends remote passes `{ sessionId }` so the session's remote jobs are cleaned up. In the `/1on1` handler:
- `action === "on"`: before `OneOnOne.lock(...)`, add
  ```ts
          const prevTarget = await Remote.findTarget(channelId, threadTs);
          if (prevTarget && prevTarget.user_id !== userId) await endRemoteForThread(channelId, threadTs, { sessionId: session.id });
  ```
- the release path (after `const existing = … if (!existing) …`): before `OneOnOne.unlock(...)`, add
  ```ts
        const r = await endRemoteForThread(channelId, threadTs, { sessionId: session.id });
  ```
  and change its reply to `":unlock: 1on1 released — the thread is open again." + (r.ended ? " Remote mode ended." : "")`.

In `agentOneOnOne` (its first parameter is `sessionId`):
- `"lock"` branch: before `OneOnOne.lock`, same `prevTarget` check as above using `ctx.channel`/`threadTs` and `{ sessionId }`.
- `"open"` branch: before `OneOnOne.setOpen`, add `await endRemoteForThread(ctx.channel, threadTs, { sessionId });` (open mode forbids remote).
- `"off"` branch: before `OneOnOne.unlock`, add `await endRemoteForThread(ctx.channel, threadTs, { sessionId });`.

(c) Mono wiring — next to `agent.setPermissionResolver(permissions.resolver);` (line ~559):

```ts
  if (env.remote.enabled() && env.role() !== "gateway") {
    // Mono: the query runs in this process, so resolve the target from the DB
    // and open the helper here. In split deploys the node does this from claims.
    agent.setRemote(
      async (sessionId) => {
        const row = await Sessions.findById(sessionId);
        return row?.slack_channel_id && row.slack_thread_ts ? activeRemoteTarget(row.slack_channel_id, row.slack_thread_ts) : null;
      },
      async (sessionId, t) => {
        const key = await Remote.getKey(t.teamId, t.userId);
        if (!key) throw new Error("remote key missing for target owner");
        return new HelperClient({
          transport: { kind: "tailcat", addr: t.addr },
          privateKey: key.privateKey,
          onDispose: async (exec) => { await exec(cleanupCommand(sessionId), { timeoutMs: 30_000 }); },
        });
      },
    );
  }
```

Check `env.role()`'s return values in `src/config/env.ts` (the extract lists mono/gateway/node), that `env` is already imported in `gateway.ts` (add `import { env } from "../../config/env";` if not), and that `Sessions` is the `../../db/sessions` namespace already imported at line 57.

(d) Status marker — in `src/gateway/core/status-text.ts` change the signature to `humanizeToolStatus(tool: string, input: any, opts: { remote?: boolean } = {})` and the final line to:

```ts
  return redactSecrets(opts.remote ? `${label} (remote)` : label);
```

In `gateway.ts` at the `humanizeToolStatus(e.tool, e.input as any)` call (line ~1144) pass a cached flag. Add near the other per-gateway maps:

```ts
  /** sessionId → remote on?, cached briefly for the status line. */
  const remoteStatusCache = new Map<string, { on: boolean; at: number }>();
  const remoteOn = async (sessionId: string, channel: string, thread: string): Promise<boolean> => {
    if (!env.remote.enabled()) return false;
    const c = remoteStatusCache.get(sessionId);
    if (c && Date.now() - c.at < 30_000) return c.on;
    const on = !!(await activeRemoteTarget(channel, thread));
    remoteStatusCache.set(sessionId, { on, at: Date.now() });
    return on;
  };
```

and change the call to:

```ts
          void (async () => status.set(
            e.sessionId,
            route.ctx.channel,
            route.ctx.threadTs,
            humanizeToolStatus(e.tool, e.input as any, { remote: await remoteOn(e.sessionId, route.ctx.channel, route.ctx.threadTs) }),
          ))();
```

In the `/remote` handler's `reload` callback also call `remoteStatusCache.delete(session.id)`.

(e) Create `tests/gateway/core/status-text.test.ts` (no such file exists today) with `import { describe, it, expect } from "bun:test"; import { humanizeToolStatus } from "../../../src/gateway/core/status-text";` and:

```ts
it("appends a remote marker without leaking args", () => {
  expect(humanizeToolStatus("Bash", { command: "curl -H 'Authorization: x' https://a" }, { remote: true })).toBe("running `curl` (remote)");
});
```

- [ ] **Step 6: Run the gateway suites**

Run: `bun test tests/gateway tests/commands.test.ts tests/db`
Expected: PASS, including the existing `/1on1` sim scenarios (`one-on-one-*.yaml`) unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/gateway/slack/commands.ts src/gateway/core/remote-command.ts src/gateway/core/gateway.ts src/gateway/core/status-text.ts tests/gateway/slack/commands-remote.test.ts tests/gateway/core/remote-command.test.ts tests/gateway/core/status-text.test.ts
git commit -m "feat(remote): /remote command with pre-flight, auto-lock, and 1on1 invariants"
```

---

### Task 11: Split deploys — claims, key endpoint, node wiring

**Files:**
- Modify: `src/gateway/api/auth.ts`, `src/gateway/core/dispatch.ts`
- Create: `src/gateway/api/remote-key.ts`
- Modify: `src/gateway/api/index.ts`
- Modify: `src/node/client.ts`, `src/node/worker.ts`
- Test: `tests/gateway/api/remote-key.test.ts`, `tests/gateway/core/dispatch-remote.test.ts`, `tests/node/remote-claims.test.ts`

**Interfaces:**
- Consumes: `activeRemoteTarget`, `sessionConfigFp`, `Remote.getKey`, `HelperClient`, `cleanupCommand`
- Produces:
  - `JobClaims.remote?: { addr: string; dir: string }`, `JobClaims.sessionConfigFp?: string`
  - `GET /v1/tenants/:tenant/remote-key` → `200 { privateKey }` | `403` | `404`
  - `NodeClient.getRemoteKey(tenantId: string, jobToken: string): Promise<string>`
  - `decodeClaims(token: string): Partial<JobClaims> | null` in `src/node/worker.ts` (exported for tests)

- [ ] **Step 1: Write the failing endpoint test**

`tests/gateway/api/remote-key.test.ts`:

```ts
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createV1Api } from "../../../src/gateway/api/index";
import { mintJobToken, JOB_HEADER } from "../../../src/gateway/api/auth";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import * as Remote from "../../../src/db/remote";

const NODE_TOKEN = "test-node-token";
const PATH = "/v1/tenants/t1/remote-key";
const tok = (over: Record<string, unknown> = {}) => mintJobToken({
  tenant: "t1", persona: "default", session: "S1", team: "T1", channel: "C1", thread: "1.1",
  initiator: "UTESTA", scope: "turn", runAs: "user:UTESTA", remote: { addr: "tcA", dir: "/r" }, ...over,
} as any);
const get = (jobToken: string, path = PATH) => createV1Api({ tools: {} as any }).fetch(
  new Request(`http://gw${path}`, { headers: { authorization: `Bearer ${NODE_TOKEN}`, [JOB_HEADER]: jobToken } }),
);

beforeAll(() => { process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN; process.env.SLAUDE_JOB_SECRET = "test-job-secret"; });
beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 3).toString("base64");
  __resetMasterKeyCache();
  await Remote._wipeForTests();
  await Remote.putKeyIfAbsent("T1", "UTESTA", { privateKey: "PRIV-A", publicKey: "PUB-A" });
});

describe("remote-key endpoint", () => {
  test("serves the runAs user's key when the claims carry remote", async () => {
    const res = await get(tok());
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).privateKey).toBe("PRIV-A");
  });
  test("refuses without a remote claim", async () => {
    const res = await get(tok({ remote: undefined }));
    expect(res!.status).toBe(403);
    expect(await res!.text()).not.toContain("PRIV");
  });
  test("refuses an agent-scoped token", async () => {
    expect((await get(tok({ runAs: "agent" })))!.status).toBe(403);
  });
  test("refuses a token with no runAs", async () => {
    expect((await get(tok({ runAs: undefined })))!.status).toBe(403);
  });
  test("404 when that user has no key (another user's key is never served)", async () => {
    const res = await get(tok({ runAs: "user:UTESTB", initiator: "UTESTB" }));
    expect(res!.status).toBe(404);
    expect(await res!.text()).not.toContain("PRIV");
  });
  test("tenant mismatch → 403", async () => {
    expect((await get(tok(), "/v1/tenants/other/remote-key"))!.status).toBe(403);
  });
});
```

- [ ] **Step 2: Implement claims + endpoint**

`src/gateway/api/auth.ts` — add to `JobClaims` (after `runAs`):

```ts
  /** Remote execution target for this turn (spec §4.5). Present only when the
   *  thread's remote target belongs to the runAs user. Sensitive: the address. */
  remote?: { addr: string; dir: string };
  /** Hash of (lock owner, remote target). A node reboots a warm session when it changes. */
  sessionConfigFp?: string;
```

`src/gateway/api/remote-key.ts`:

```ts
import type { JobClaims } from "./auth";
import { json } from "./http";
import { parseRunAs } from "../../agent/credential-owner";
import * as Remote from "../../db/remote";

/** The runAs user's SSH private key, for a turn whose signed claims put it in
 *  remote mode. Nothing else can obtain it (spec §4.5). */
export async function handleRemoteKey(_req: Request, claims: JobClaims): Promise<Response> {
  const runAs = parseRunAs(claims.runAs);
  if (!runAs || runAs.kind !== "user") return json(403, { error: "remote keys are only served to user-scoped turns" });
  if (!claims.remote) return json(403, { error: "this turn is not in remote mode" });
  const key = await Remote.getKey(claims.team, runAs.slackUserId);
  if (!key) return json(404, { error: "no remote key" });
  return json(200, { privateKey: key.privateKey });
}
```

`src/gateway/api/index.ts` — import `handleRemoteKey` and add, next to the `mcp-credentials` route (and a line in the doc-comment route table: `GET /v1/tenants/:t/remote-key  (job token) → runAs user's SSH key for a remote-mode turn`):

```ts
      if (seg.length === 4 && seg[1] === "tenants" && seg[3] === "remote-key") {
        if (req.method !== "GET") return methodNotAllowed();
        const job = requireJobToken(req);
        if ("response" in job) return job.response;
        if (job.claims.tenant !== seg[2]!) return json(403, { error: "job token is not scoped to this tenant" });
        return await handleRemoteKey(req, job.claims);
      }
```

Run: `bun test tests/gateway/api/remote-key.test.ts` → PASS.

- [ ] **Step 3: Write the failing dispatch test**

`tests/gateway/core/dispatch-remote.test.ts` — copy the imports (lines 1–6) and `function harness(lockOwner)` (lines 15–51) **verbatim** from `tests/gateway/core/dispatch-run-as.test.ts`. The harness stubs `agent.resolveEffectiveIdentity` to return `lockOwner`, which is where dispatch gets `runAsUser`; the DB lock rows below must agree with it because `activeRemoteTarget` reads the real tables. Then:

```ts
import { afterEach } from "bun:test";
import * as OneOnOne from "../../../src/db/one-on-one";
import * as Remote from "../../../src/db/remote";
import { sessionConfigFp } from "../../../src/remote/fingerprint";

const META = { teamId: "TTESTTEAM1", channelId: "C1", threadTs: "1.1", eventTs: "1.1" };
const SESSION = { id: "S1" } as unknown as SessionRow;

describe("dispatch remote claims", () => {
  beforeEach(async () => {
    process.env.SLAUDE_JOB_SECRET = "test-secret";
    process.env.SLAUDE_REMOTE = "1";
    await OneOnOne._wipeForTests();
    await Remote._wipeForTests();
  });
  afterEach(() => { delete process.env.SLAUDE_REMOTE; });

  it("adds remote + fp when the target belongs to the lock owner", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.1", lockedUser: "UTESTA", createdBy: "UTESTA" });
    await Remote.setTarget({ channelId: "C1", threadTs: "1.1", teamId: "TTESTTEAM1", userId: "UTESTA", addr: "tcA", dir: "/r", lockByRemote: true });
    const h = harness("UTESTA");
    await h.dispatch.dispatch(SESSION, "hi", { ...META, userId: "UTESTA" });
    expect(h.claims().runAs).toBe("user:UTESTA");
    expect(h.claims().remote).toEqual({ addr: "tcA", dir: "/r" });
    expect(h.claims().sessionConfigFp).toBe(sessionConfigFp("UTESTA", { addr: "tcA", dir: "/r" }));
    await h.dispatch.close();
  });

  it("no remote claim when the lock moved to someone else; fp still minted", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.1", lockedUser: "UTESTMGR", createdBy: "UTESTMGR" });
    await Remote.setTarget({ channelId: "C1", threadTs: "1.1", teamId: "TTESTTEAM1", userId: "UTESTA", addr: "tcA", dir: "/r", lockByRemote: true });
    const h = harness("UTESTMGR");
    await h.dispatch.dispatch(SESSION, "hi", { ...META, userId: "UTESTMGR" });
    expect(h.claims().remote).toBeUndefined();
    expect(h.claims().sessionConfigFp).toBe(sessionConfigFp("UTESTMGR", null));
    await h.dispatch.close();
  });

  it("an ordinary (agent) thread gets no remote claim", async () => {
    const h = harness(undefined);
    await h.dispatch.dispatch(SESSION, "hi", { ...META, userId: "UTESTA" });
    expect(h.claims().remote).toBeUndefined();
    expect(h.claims().sessionConfigFp).toBe(sessionConfigFp(null, null));
    await h.dispatch.close();
  });

  it("flag off: neither claim", async () => {
    delete process.env.SLAUDE_REMOTE;
    const h = harness("UTESTA");
    await h.dispatch.dispatch(SESSION, "hi", { ...META, userId: "UTESTA" });
    expect(h.claims().remote).toBeUndefined();
    expect(h.claims().sessionConfigFp).toBeUndefined();
    await h.dispatch.close();
  });
});
```

(The copied import block already brings `beforeEach`, `describe`, `expect`, `test`, `verifyJobToken`, `makeQueueDispatch` and `SessionRow`; use `it` from `bun:test` or rename to `test` consistently.)

- [ ] **Step 4: Implement in `dispatch.ts`**

Imports:

```ts
import { env } from "../../config/env";
import { activeRemoteTarget } from "../../remote/active";
import { sessionConfigFp } from "../../remote/fingerprint";
```

After `const runAsUser = …;` and before `mintJobToken`:

```ts
      // Remote mode (spec §4.5): only a target owned by the runAs user is signed in.
      const remoteTarget = env.remote.enabled() ? await activeRemoteTarget(meta.channelId, meta.threadTs) : null;
      const remoteClaim = remoteTarget && remoteTarget.userId === runAsUser ? { addr: remoteTarget.addr, dir: remoteTarget.dir } : undefined;
```

In the `mintJobToken({...})` object add:

```ts
        ...(env.remote.enabled()
          ? { sessionConfigFp: sessionConfigFp(runAsUser ?? null, remoteClaim ?? null), ...(remoteClaim ? { remote: remoteClaim } : {}) }
          : {}),
```

Run: `bun test tests/gateway/core/dispatch-remote.test.ts tests/gateway/core/dispatch-run-as.test.ts` → PASS.

- [ ] **Step 5: Write the failing node test**

`tests/node/remote-claims.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { mintJobToken } from "../../src/gateway/api/auth";
import { decodeClaims } from "../../src/node/worker";

describe("decodeClaims", () => {
  it("reads remote and fp from a job token", () => {
    process.env.SLAUDE_JOB_SECRET = "s";
    const t = mintJobToken({ tenant: "t", persona: "p", session: "S", team: "T", channel: "C", thread: "1", initiator: "U", scope: "turn", runAs: "user:U", remote: { addr: "tcA", dir: "/r" }, sessionConfigFp: "abc" } as any);
    const c = decodeClaims(t)!;
    expect(c.remote).toEqual({ addr: "tcA", dir: "/r" });
    expect(c.sessionConfigFp).toBe("abc");
  });
  it("returns null for garbage", () => {
    expect(decodeClaims("not.a.token")).toBeNull();
  });
});
```

- [ ] **Step 6: Implement node side**

`src/node/client.ts` — after `getMcpCredentials`:

```ts
  /** The runAs user's SSH key for a remote-mode turn (never cached on disk). */
  async getRemoteKey(tenantId: string, jobToken: string): Promise<string> {
    const res = await this.request(`/v1/tenants/${encodeURIComponent(tenantId)}/remote-key`, { jobToken });
    const body = await this.#json<{ privateKey?: string }>(res);
    if (!body.privateKey) throw new NodeApiError(502, "", "gateway returned no remote key");
    return body.privateKey;
  }
```

`src/node/worker.ts`:

Export a decoder next to `tokenAgeFraction` (the node trusts the gateway-minted token it was handed; the gateway verifies the signature on every call that matters):

```ts
export function decodeClaims(token: string): Partial<import("../gateway/api/auth").JobClaims> | null {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
```

After the `setChildEnvResolver(...)` block, wire remote from claims:

```ts
  agent.setRemote(
    async (sessionId) => {
      const token = store.tokenFor(sessionId);
      const c = token ? decodeClaims(token) : null;
      const runAs = c?.runAs?.startsWith("user:") ? c.runAs.slice(5) : null;
      if (!c?.remote || !runAs) return null;
      return { teamId: c.team ?? "", userId: runAs, addr: c.remote.addr, dir: c.remote.dir };
    },
    async (sessionId) => {
      const tenant = tenants.get(sessionId);
      const token = store.tokenFor(sessionId);
      if (!tenant || !token) throw new Error("no job token for remote session");
      const c = decodeClaims(token);
      const privateKey = await client.getRemoteKey(tenant, token);
      return new HelperClient({
        transport: { kind: "tailcat", addr: c!.remote!.addr },
        privateKey,
        onDispose: async (exec) => { await exec(cleanupCommand(sessionId), { timeoutMs: 30_000 }); },
      });
    },
  );
```

(imports: `import { HelperClient } from "../remote/helper-client";` and `import { cleanupCommand } from "../remote/tools/bash";`)

In the claim step, right after `store.bindToken(data.sessionId, jobToken);` (line ~345):

```ts
    await agent.ensureConfigFp(data.sessionId, decodeClaims(jobToken)?.sessionConfigFp);
```

- [ ] **Step 7: Run tests**

Run: `bun test tests/node tests/gateway/api tests/gateway/core/dispatch-remote.test.ts`
Expected: PASS, including existing `worker-e2e`.

- [ ] **Step 8: Commit**

```bash
git add src/gateway/api/auth.ts src/gateway/api/remote-key.ts src/gateway/api/index.ts src/gateway/core/dispatch.ts src/node/client.ts src/node/worker.ts tests/gateway/api/remote-key.test.ts tests/gateway/core/dispatch-remote.test.ts tests/node/remote-claims.test.ts
git commit -m "feat(remote): signed remote claims, key endpoint, and node fingerprint reload"
```

---

### Task 12: Image, docs, full-suite verification

**Files:**
- Modify: `Dockerfile`
- Create: `docs/site/_content/guides/remote.md`
- Create: `docs/site/_content/field-notes/2026-09-30-remote-exec.md`
- Modify: `CLAUDE.md` (Findings Log index, newest first)

- [ ] **Step 1: Install tailcat in the runtime image**

In `Dockerfile`, runtime stage (`FROM oven/bun:1.3-debian` at line 23), add after the `apt-get … uvx` `RUN` block:

```dockerfile
# tailcat: SSH transport for /remote (runs a thread's tools on the user's machine).
ARG TAILCAT_VERSION=0.7.0
ARG TARGETARCH
RUN arch="${TARGETARCH:-amd64}" \
 && curl -LsSf "https://github.com/tailscale/tailcat/releases/download/v${TAILCAT_VERSION}/tailcat_${TAILCAT_VERSION}_linux_${arch}.tar.gz" \
    | tar -xz -C /usr/local/bin tailcat \
 && tailcat version
```

Run: `docker build -t slaude:remote-test .` then `docker run --rm --entrypoint tailcat slaude:remote-test version`
Expected: prints `v0.7.0`. (If Docker is unavailable locally, say so in the task report; CI builds the image.)

- [ ] **Step 2: User guide** — `docs/site/_content/guides/remote.md`:

```markdown
---
title: Remote mode (/remote)
---

# Run the agent's tools on your machine

`/remote` points a thread at **your** machine: from the next message on, the
agent's shell and file tools (Bash, Read, Write, Edit, Glob, Grep) run there, in
a directory you choose. The conversation, knowledge base and integrations stay
on slaude. `/remote off` switches back.

Requires the deployment to set `SLAUDE_REMOTE=1`.

## Set up (once)

1. In the thread, type `/remote key`. slaude replies privately with a public key
   and the exact command.
2. Install [tailcat](https://github.com/tailscale/tailcat) and run:
   ```sh
   tailcat genkey --key=default          # once: keeps your address stable
   tailcat serve --key=default --ssh-authorized-keys="ssh-ed25519 AAAA… slaude:<you>" ssh
   ```
3. Copy the address it prints.

## Use it

| Command | Effect |
|---|---|
| `/remote <address> <directory>` | Switch this thread to your machine. Locks the thread to you (`/1on1`). |
| `/remote <address>` | New address (tailcat restarted), same directory. |
| `/remote` | Status: on/off, directory, direct or relayed path. |
| `/remote off` | Back to the server. Releases the lock if `/remote` created it. |

`/1on1 off` or opening the 1on1 to guests also ends remote mode.

## What to know

- Commands run as the account that runs `tailcat serve`, with everything that
  account can reach. Use a separate account or a container for untrusted repos.
- Tools never fall back to the server: if your machine sleeps, the agent stops
  and tells you. Wake it (or restart `tailcat serve`) and continue.
- `grep`/`find` are used by default; installing `ripgrep` makes search faster
  and enables multiline search and `type` filters for any language.
- Directories with two consecutive spaces in their name are not supported in
  the command (single spaces are fine).
```

- [ ] **Step 3: Field note** — `docs/site/_content/field-notes/2026-09-30-remote-exec.md`: describe the mechanism only (no deployment specifics):
  - Why tools move, not the CLI (key/credentials/transcript stay put).
  - `toolAliases` finding: disallowing built-ins made the model hunt for them with `ToolSearch`; enabling them plus aliases keeps native schemas, and hooks see the post-alias name — so a `PreToolUse` deny on built-in names is a clean guard.
  - tailcat's SSH server runs `$SHELL -c` non-login with a minimal PATH; macOS lacks `setsid` and `rg`; closing an exec channel without a pty orphans the process → perl `setpgrp` + group kill.
  - The node reload gap and the signed `sessionConfigFp` fix.
  - Key custody: private key encrypted at rest, served only to a user-scoped remote-mode turn, held only in the helper's memory. The tailcat address is not secret once key auth is required, but it does travel in the job token and therefore sits in the queue's job data (Redis) for the job's lifetime.
  - A connection drop during a command is reported, never retried: re-running a half-executed command is worse than surfacing the drop.
  - Background jobs survive session reboots and are cleaned up when remote mode ends, from the gateway, so it works even if no further turn reaches a node.
  - Spike numbers from spec §8.

- [ ] **Step 4: CLAUDE.md index** — add at the top of the Findings Log list:

```markdown
- [2026-09-30 — /remote: a thread's shell and file tools run on the initiator's own machine over tailcat SSH, while the agent loop, credentials and transcript stay on slaude. Built-ins stay enabled and `toolAliases` reroutes them to an in-process MCP server (disallowing them made the model search for them instead); a PreToolUse deny on built-in names guards internal calls since hooks see the post-alias name. Remote implies a locked /1on1; a signed session-config fingerprint makes nodes reboot warm sessions when the lock or target changes, which also fixes /1on1's stale mode block on nodes](docs/site/_content/field-notes/2026-09-30-remote-exec.md)
```

- [ ] **Step 5: Full verification**

Run: `bun test`
Expected: all pass (baseline was 2063 pass / 0 fail / 110 skip; new tests add to pass). Record the exact numbers in the task report.

Run: `SLAUDE_DB=pg bun test tests/db/remote.test.ts` if a test Postgres is configured (`SLAUDE_PG_TEST_URL`); otherwise state that the pg path was not exercised locally.

Run: `bunx tsc --noEmit` (or the repo's typecheck script if `package.json` defines one)
Expected: no errors.

- [ ] **Step 6: Manual smoke (mono, real tailcat)** — with `SLAUDE_REMOTE=1` in a sim/dev workspace:
  1. `/remote key` → private setup message.
  2. Run `tailcat serve …` locally; `/remote <addr> ~/tmp-remote-test`.
  3. Ask the agent: "create hello.txt with hi, then show its contents and run `uname -a`". Confirm the file appears in `~/tmp-remote-test` on the machine and the status line shows `(remote)`.
  4. Stop `tailcat serve`; ask for `ls`. Expect one clear "your machine is not reachable" message, no retry loop.
  5. `/remote off`; ask for `pwd` → the server workspace.
  6. Note warm-exec timings from the `[remote] … ms=` audit lines; confirm p50 < 150 ms on a direct path.

- [ ] **Step 7: Commit**

```bash
git add Dockerfile docs/site/_content/guides/remote.md docs/site/_content/field-notes/2026-09-30-remote-exec.md CLAUDE.md
git commit -m "docs(remote): guide, field note, and tailcat in the runtime image"
```

---

## Spec deviations (decided while planning — flag in review)

1. **No separate Slack notice per outage.** The tool error carries the guidance and the mode block instructs the model to stop and tell the user once; this yields one message per outage without a node→surface side channel. Revisit if the model is seen looping.
2. **`/remote` status omits the running background-job list** (spec §2 table). Listing needs an exec from the gateway to the remote; status shows on/off, dir and path only. Jobs remain discoverable via `bash_output` and are cleaned up on off/session end.
3. **No `slaude remote-helper` CLI subcommand.** The helper is spawned directly as `bun src/remote/helper-main.ts`; a subcommand adds nothing.
4. **No sim YAML scenario.** Scenario transcripts run with default env (flag off) and cannot fake the network pre-flight; `tests/gateway/core/remote-command.test.ts` covers the same flows through the handler with injected deps.
5. **Glob semantics:** without ripgrep, a pattern without a directory part (e.g. `*.ts`) matches at any depth (find's `*` spans `/`), where the built-in matches top level only.
6. **Background jobs survive session reboots and idle timeouts** (spec §5.2 said "session end"). Reboots happen for many reasons (reload, `stream_closed`, idle TTL, `/mcp connect`) that the user never sees as "ending" anything; killing a long build on each would be surprising. Jobs are killed when remote mode ends — `/remote off`, `/1on1 off`/open/owner change (from the gateway, best-effort), or a changed target at the next boot.
7. **Plan mode** denies remote Write/Edit/Bash, matching the SDK's treatment of the built-ins (the spec did not mention plan mode).
