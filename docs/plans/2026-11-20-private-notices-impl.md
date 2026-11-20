# Private Notices Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Gateway-generated notices meant for one person reach that person privately (ephemeral, then DM, never the channel), and a decided permission or approval card keeps a redacted record of what was decided.

**Architecture:** One module, `src/gateway/slack/private.ts`, owns delivery (ephemeral, DM, drop) and the notice rate limit. The gateway's command helpers `reply` and `replyPrivately` call it, a new `announce` helper keeps the deliberately public state-change lines, and a guard test makes any new public gateway post fail CI. Cards keep their blocks on a decision (the proposal-card pattern) with a stronger redaction pass. Design: `docs/plans/2026-11-20-private-notices-design.md`.

**Tech Stack:** Bun, TypeScript, `bun:test`, Slack Web API through `WebClientLike`, Block Kit.

**Ground rules (CLAUDE.md):** public repo, no real names, orgs or channels in code, tests, docs or commits; no emoji, no em-dashes; no AI trailers; run the leak scan on the staged diff before every commit; granular commits; tests run through the chunked Mac runner (one `bun test <file>` per file while iterating, never the whole suite in one process).

Decision on ordering: the design said the guard test lands first. A failing test would break every intermediate commit, so the guard lands last (Task 9), and a grep worklist (Task 0) tracks progress until then.

---

### Task 0: Branch, baseline, worklist

**Files:** none changed.

**Step 1:** from the repo root, `git worktree add -b feat/private-notices ../slaude-wt-pn docs/private-notices-design`, then `git -C ../slaude-wt-pn config core.hooksPath .githooks` and `bun install` there.

**Step 2:** baseline the touched areas: `bun test tests/gateway/outbound-sites.test.ts tests/gateway/owner-guardrails.test.ts`. Expected: PASS.

**Step 3:** record the worklist: `grep -n "await reply(" src/gateway/core/gateway.ts | wc -l` (about 78) and `grep -c "runtime-ui" src/gateway/core/gateway.ts`. Keep both numbers; Task 9 must end with no non-allowlisted public gateway post.

---

### Task 1: Switch and metrics

**Files:**
- Modify: `src/config/env.ts` (next to the other boolean flags)
- Modify: `src/metrics.ts` (next to `ephemeralReplyFailuresTotal`, line ~215)
- Test: `tests/config/env-private-notices.test.ts`

**Step 1: failing test**

```ts
import { describe, expect, it } from "bun:test";
import { env } from "../../src/config/env";

describe("SLAUDE_PRIVATE_NOTICES", () => {
  it("is on by default and off only when set false", () => {
    const old = process.env.SLAUDE_PRIVATE_NOTICES;
    try {
      delete process.env.SLAUDE_PRIVATE_NOTICES;
      expect(env.privateNotices()).toBe(true);
      process.env.SLAUDE_PRIVATE_NOTICES = "off";
      expect(env.privateNotices()).toBe(false);
    } finally {
      if (old === undefined) delete process.env.SLAUDE_PRIVATE_NOTICES; else process.env.SLAUDE_PRIVATE_NOTICES = old;
    }
  });
});
```

**Step 2:** run `bun test tests/config/env-private-notices.test.ts`. Expected: FAIL, `privateNotices` is not a function.

**Step 3:** add to `env.ts` using the same `flag(...)` helper the neighbors use (read its signature first; default true, "off", "0", "false" turn it off): `privateNotices: (): boolean => flag(opt("SLAUDE_PRIVATE_NOTICES"), true, true)`. In `metrics.ts` add two counters, `privateNoticeSentTotal` (`slaude_private_notice_sent_total`, labels `class`, `path`) and `privateNoticeDroppedTotal` (`slaude_private_notice_dropped_total`, label `class`), matching how `slackDropsTotal` declares labels.

**Step 4:** run the test. Expected: PASS. Run `bun run typecheck`.

**Step 5:** commit `feat: private notices switch and metrics`.

---

### Task 2: `sendPrivate`

**Files:**
- Create: `src/gateway/slack/private.ts`
- Test: `tests/gateway/slack/private.test.ts`

**Step 1: failing tests** (a fake client records calls; time is injected):

```ts
import { describe, expect, it } from "bun:test";
import { makePrivateSender } from "../../../src/gateway/slack/private";

const fake = (over: { eph?: () => Promise<unknown>; dm?: () => Promise<unknown> } = {}) => {
  const calls: Array<{ m: string; a: any }> = [];
  return {
    calls,
    client: {
      chat: {
        postEphemeral: async (a: any) => { calls.push({ m: "eph", a }); return (over.eph ?? (async () => ({ ok: true })))(); },
        postMessage: async (a: any) => { calls.push({ m: "post", a }); return (over.dm ?? (async () => ({ ok: true })))(); },
      },
    } as any,
  };
};
const base = { cls: "info" as const, kind: "help", userId: "U1", channel: "C1", thread: "1.1", text: "hi" };

describe("sendPrivate", () => {
  it("sends an ephemeral to the user in the thread", async () => {
    const f = fake();
    expect(await makePrivateSender().send(f.client, base)).toBe("ephemeral");
    expect(f.calls).toEqual([{ m: "eph", a: { channel: "C1", user: "U1", thread_ts: "1.1", text: "hi" } }]);
  });
  it("falls back to a DM when the ephemeral is refused, never to the channel", async () => {
    const f = fake({ eph: async () => { throw Object.assign(new Error("x"), { data: { error: "user_not_in_channel" } }); } });
    expect(await makePrivateSender().send(f.client, base)).toBe("dm");
    expect(f.calls.map((c) => c.m)).toEqual(["eph", "post"]);
    expect(f.calls[1]!.a.channel).toBe("U1");
  });
  it("drops when both fail", async () => {
    const boom = async () => { throw new Error("x"); };
    const f = fake({ eph: boom, dm: boom });
    expect(await makePrivateSender().send(f.client, base)).toBe("dropped");
  });
  it("sensitive goes straight to a DM", async () => {
    const f = fake();
    expect(await makePrivateSender().send(f.client, { ...base, cls: "sensitive" })).toBe("dm");
    expect(f.calls.map((c) => c.m)).toEqual(["post"]);
  });
  it("limits an unsolicited notice, spends the token only after delivery", async () => {
    let t = 0;
    const s = makePrivateSender({ now: () => t, windowMs: () => 600_000 });
    const n = { ...base, limitKey: "p:C1:1.1:U1:ignored" };
    const bad = fake({ eph: async () => { throw new Error("x"); }, dm: async () => { throw new Error("x"); } });
    expect(await s.send(bad.client, n)).toBe("dropped");
    const ok = fake();
    expect(await s.send(ok.client, n)).toBe("ephemeral");
    expect(await s.send(ok.client, n)).toBe("limited");
    t = 600_001;
    expect(await s.send(ok.client, n)).toBe("ephemeral");
  });
  it("never limits a solicited notice", async () => {
    const s = makePrivateSender();
    const f = fake();
    await s.send(f.client, base); await s.send(f.client, base);
    expect(f.calls.length).toBe(2);
  });
  it("with the switch off, runs the public fallback instead", async () => {
    const f = fake();
    let ran = false;
    expect(await makePrivateSender({ enabled: () => false }).send(f.client, { ...base, publicFallback: async () => { ran = true; } })).toBe("disabled");
    expect(ran).toBe(true);
    expect(f.calls).toEqual([]);
  });
  it("adds a permalink to a DM so it has context", async () => {
    const f = fake({ eph: async () => { throw new Error("x"); } });
    await makePrivateSender().send(f.client, { ...base, permalink: "https://example.test/p/1" });
    expect(f.calls[1]!.a.text).toContain("https://example.test/p/1");
  });
});
```

**Step 2:** run it. Expected: FAIL, module not found.

**Step 3: implement**

```ts
import { env } from "../../config/env";
import * as metric from "../../metrics";

export type PrivateClass = "info" | "failure" | "sensitive";
export type PrivateResult = "ephemeral" | "dm" | "dropped" | "limited" | "disabled";

export interface PrivateNotice {
  cls: PrivateClass;
  kind: string;
  userId: string;
  channel: string;
  thread?: string;
  text: string;
  blocks?: unknown[];
  /** Set for an unsolicited notice only; the key is persona:channel:thread:user:kind. */
  limitKey?: string;
  permalink?: string;
  /** Run when SLAUDE_PRIVATE_NOTICES is off: the old public behavior, kept as a rollback. */
  publicFallback?: () => Promise<void>;
}
export interface PrivateClient {
  chat: { postEphemeral(a: any): Promise<any>; postMessage(a: any): Promise<any> };
}
interface Deps { now?: () => number; windowMs?: () => number; enabled?: () => boolean }

export function makePrivateSender(deps: Deps = {}) {
  const now = deps.now ?? Date.now;
  const windowMs = deps.windowMs ?? (() => 10 * 60_000);
  const enabled = deps.enabled ?? (() => env.privateNotices());
  const until = new Map<string, number>();
  const cap = 5000;
  const quiet = (k: string) => (until.get(k) ?? 0) > now();
  const spend = (k: string) => {
    until.delete(k);
    until.set(k, now() + windowMs());
    if (until.size > cap) until.delete(until.keys().next().value as string);
  };
  const reason = (e: unknown) => (e as any)?.data?.error ?? (e as Error)?.message ?? String(e);

  async function send(client: PrivateClient, n: PrivateNotice): Promise<PrivateResult> {
    if (!enabled()) {
      await n.publicFallback?.();
      return "disabled";
    }
    if (n.limitKey && quiet(n.limitKey)) return "limited";
    const done = (path: "ephemeral" | "dm"): PrivateResult => {
      if (n.limitKey) spend(n.limitKey);
      metric.privateNoticeSentTotal.inc({ class: n.cls, path });
      return path;
    };
    if (n.cls !== "sensitive") {
      try {
        await client.chat.postEphemeral({
          channel: n.channel, user: n.userId, ...(n.thread ? { thread_ts: n.thread } : {}),
          text: n.text, ...(n.blocks ? { blocks: n.blocks } : {}),
        });
        return done("ephemeral");
      } catch (e) {
        console.error(`[private-notice] ephemeral failed kind=${n.kind} ch=${n.channel}: ${reason(e)}`);
      }
    }
    try {
      const text = n.permalink ? `${n.text}\n<${n.permalink}|Open the thread>` : n.text;
      await client.chat.postMessage({ channel: n.userId, text, ...(n.blocks ? { blocks: n.blocks } : {}) });
      return done("dm");
    } catch (e) {
      console.error(`[private-notice] dm failed kind=${n.kind}: ${reason(e)}`);
      metric.privateNoticeDroppedTotal.inc({ class: n.cls });
      return "dropped";
    }
  }
  return { send };
}

/** The process-wide sender the gateway uses. */
export const privateSender = makePrivateSender();
```

The DM call has no marker comment yet: mark both Slack writes in this file `// private-ui: <class>` is added in Task 9; until then use `// runtime-ui: private notice delivery` on each write line so the current test stays green.

**Step 4:** run `bun test tests/gateway/slack/private.test.ts` and `bun test tests/gateway/outbound-sites.test.ts`. Expected: PASS. Typecheck.

**Step 5:** commit `feat: sendPrivate, a private delivery ladder with a notice limiter`.

---

### Task 3: Command replies move to `sendPrivate`

**Files:**
- Modify: `src/gateway/core/gateway.ts` (the `reply` and `replyPrivately` helpers at ~3103-3135, and the call sites in the command block 3176-3964)
- Test: `tests/gateway/private-commands.test.ts`

**Step 1: failing test.** Use the existing sim harness pattern from the nearest command test (find with `grep -ln "/help" tests/gateway/*.test.ts`). Cases: (a) `/help` in a channel thread posts through `chat.postEphemeral` to the sender and `chat.postMessage` is never called with the help text; (b) `/mode plan` is the only kind that posts publicly, one short line; (c) with the user not in the channel (ephemeral throws `user_not_in_channel`) the help text goes to a DM, never the thread.

**Step 2:** run. Expected: FAIL (help is public today).

**Step 3: implement.** In the command block:
- `reply` becomes private: build a notice `{ cls: "info", kind: "command", userId, channel: channelId, thread: <slashThread.thread_ts>, text: txt }` and call `privateSender.send(outClientForPersona(dispatch?.personaId, app), notice)`, with `publicFallback` set to the old `chat.postMessage` body. Keep `slashThread` (a channel session answers at root).
- `replyPrivately` keeps its error-reaction floor but delegates to `reply` (it is now identical for the channel session case); on a `dropped` result add the `REACT_ERROR` reaction as today.
- New `announce(txt)`: the old public `postMessage`, for the public state changes only.
- Reclassify call sites. Change to `announce`: `/new` (3176), `/mode` set (3259), `/abort` (3270), `/ignore` and `/unignore` replies (3588, 3604, 3617, 3621), mention-only on and off (3361, 3369), `/soul` set and clear (3394, 3409), cron created, updated, removed, paused, resumed (3685, 3705, 3716, 3762, 3824). Everything else stays `reply`, which is now private. `/1on1` lock (3298), re-lock (3343) and release (3355) stay `reply`: the lock confirmation is private by owner decision.
- Failures that block a user (`:lock: only the session owner...`, `/mcp` lock refusal 3479) pass `cls: "failure"`: add an optional second argument `reply(txt, { cls })`.
- `/bash` output (3962, 3964) stays `reply`.

**Step 4:** run the new test, then `bun test tests/gateway` files that touch commands one by one (`grep -l "parseSlashCommand\|/help\|/mode" tests/gateway/*.test.ts`); fix expectations that asserted a public reply.

**Step 5:** commit `feat: command replies are private; state changes keep one public line`.

---

### Task 4: 1on1 and ignore rejection notices, guardrail reply without a public fallback

**Files:**
- Modify: `src/gateway/core/gateway.ts` (the 1on1 gate ~3049-3080, the drop handling ~3010-3035)
- Test: `tests/gateway/private-rejections.test.ts`

**Step 1: failing tests.** (a) A non-owner posts in a locked thread: the agent does not run, the sender gets one ephemeral naming the lock owner, a second message inside 10 minutes gets none; the owner and the manager get none. (b) An ignored user posts: one private notice, sent from `handleMessage` (assert the decision gate's read-only `ingressDrops` path sends nothing). (c) The guardrail reply, with the ephemeral failing, goes to a DM and `postMessage` is never called with the thread as the channel.

**Step 2:** run. Expected: FAIL.

**Step 3: implement.**
- In the 1on1 gate, before each `return` that drops a non-owner (two places), call `privateSender.send` with `{ cls: "info", kind: "one_on_one", limitKey: persona:channel:thread:user:one_on_one, text: "This thread is locked 1on1 to <@owner> (and the manager), so I did not respond to your message." }`. Skip it for recordings (`recordingOnly`) and when `dispatch?.channelSession && suppress`.
- For the ignore drop, `handleMessage`'s `if (drop)` block: add `drop.reason === "ignored"` (use the real reason string from `preTurnDropReason`, ~4544) next to the `owner_guardrail` branch, same limiter pattern, kind `ignored`, text "I am set to ignore you here. Ask a manager if that is a mistake."
- Replace the guardrail reply's `postEphemeral` with the public `postMessage` fallback by `privateSender.send` (cls `info`, kind `guardrail`, `limitKey` as it is today via `makeReplyQuiet`'s key), so the public fallback disappears. Remove `guardrailReplyQuiet` if now unused.

**Step 4:** run the new test plus `tests/gateway/owner-guardrails.test.ts`. Expected: PASS.

**Step 5:** commit `feat: private notices for 1on1 and ignore rejections`.

---

### Task 5: OAuth links and the paste

**Files:**
- Modify: `src/gateway/core/gateway.ts` (`connectServer` ~2196-2300, the paste handler ~3205-3215, the view and action registrations near the `/remote` modal ~2500-2560)
- Create: `src/gateway/slack/oauth-paste-modal.ts` (modal builder and offer encode/decode, modeled on `envAddModal` and `decodeEnvOffer`)
- Test: `tests/gateway/oauth-paste.test.ts`

**Step 1: failing tests.** (a) Loopback `postAuthorizeUrl` goes through `privateSender` (a DM or ephemeral to the initiator), never `surface.reply`. (b) Paste-back: the authorize link and a "Paste callback" button go out as `sensitive` (DM); clicking the button calls `views.open` with a modal whose `private_metadata` is a signed offer; submitting with a mismatched `body.user.id` is refused; a valid submit resumes the parked flow and the result arrives as a private notice. (c) A callback-shaped text with no parked flow is not forwarded to the model and gets a private "that link has expired" notice. (d) HTTP `view_submission` (ack no-op) completes the flow in the background.

**Step 2:** run. Expected: FAIL.

**Step 3: implement.** Reuse `signOffer` and `decodeEnvOffer`'s pattern (read `src/gateway/slack/` env offer code first and mirror its signing, user binding and max age). Handler: rebuild the pasteKey from `body.user.id`, never from metadata. Do the exchange after returning (the existing `runExchange`), report through `privateSender` with kind `oauth_result`. Keep the thread paste path, add the private warning, and the expired-paste branch. The "edit the link away" step stays for the DM path only.

**Step 4:** run the new test, `tests/agent/mcp-oauth*` and the existing connect tests one by one.

**Step 5:** commit in two: `feat: OAuth authorize links are private (loopback and paste-back)`, `feat: OAuth callback entered in a private modal`.

---

### Task 6: Audit entry for decided cards

**Files:**
- Modify: `src/gateway/slack/permission-gate.ts` (decision sites ~600-660 and the card builder), `src/gateway/slack/approval-gate.ts` (~214-280, ~345-351, ~568-575, ~686-693)
- Modify: `src/audit/redact.ts` or a new `src/redact/card.ts` (string pass)
- Test: `tests/gateway/card-audit.test.ts`, `tests/redact/card.test.ts`

**Step 1: failing tests.** Redaction: `postgres://u:p@host/db` and `curl -u user:pass x` and `--password hunter2` and a PEM block and `?X-Amz-Signature=abc` are masked; a long token is masked before truncation; Write input shows path and size, never content. Cards: a click keeps the card's blocks, drops the actions block, appends "Approved by <@U1>, <time>"; if `respond` throws on the rich version the fallback one-line text is sent; an expired or aborted permission card is edited to "Expired" or "Cancelled" with no buttons; the held-reply approval card never contains the held text.

**Step 2:** run. Expected: FAIL.

**Step 3: implement.** Add `decidedBlocks(blocks, actionsBlockId, line)` next to `withDecision` (reuse it; export it from a neutral module so gates do not import `background/`). Apply `redactValue` plus the new patterns to the input shown, truncate after, cap at 1,500 characters, never truncate `voice_start`. On expiry and abort, edit the stored card (the pending row has `channel` and `ts`; the sweep and abort paths call `chat.update` with a `// runtime-ui: permission card` marker).

**Step 4:** run the new tests and `tests/gateway/permission-gate*.test.ts`, `approval-gate*.test.ts`.

**Step 5:** commit `feat: decided cards keep a redacted record`, then `feat: expired and aborted cards close`.

---

### Task 7: The other deterministic posts

**Files:** `src/gateway/core/gateway.ts` (promise line ~1392, bridge connect and reauth card ~5406, turn failure ~2902, `/mcp` status card ~3564, ops hold ~4285, proactive feedback ~4761).

For each, apply the design's default and a test that pins it: bridge card to the manager by DM; turn failure `failure` class plus error reaction; `/mcp` status card private and interactive; promise line, ops hold and proactive feedback explicitly stay public and are named in the guard allowlist (Task 9) with a reason.

Commit per site group: `feat: bridge reauth and turn failure notices are private`, `feat: /mcp status card is private`.

---

### Task 8: Docs

**Files:** `docs/site/_content/reference/configuration.md` (SLAUDE_PRIVATE_NOTICES), `docs/site/_content/releases/v0.46.0.md` (new rc section), a field note `docs/site/_content/field-notes/2026-11-20-private-notices.md` plus its index line in `CLAUDE.md`, and the metrics reference if one exists. Leak scan and the no-em-dash check on every file. Commit `docs: private notices`.

---

### Task 9: Guard test

**Files:** `tests/gateway/outbound-sites.test.ts`, `src/gateway/slack/outbound.ts` (`SLACK_WRITE`).

**Step 1:** extend the test: scan with a multi-line aware pass (`chat\s*\.update\s*\(` across a newline), accept the `// private-ui: <class>` marker, add `surface.reply({ runtime: true })` to the audited forms, and fail on a `runtime-ui` marker whose file and reason are not in an allowlist (gate cards, `views.*`, the named public sites from Tasks 3 and 7, each with a reason string).

**Step 2:** run it. Fix every real site it finds (it should be the worklist from Task 0, now empty).

**Step 3:** commit `test: a deterministic gateway post must be private or on the allowlist`.

---

### Task 10: Verify and ship

1. `bun run typecheck`; the chunked Mac runner over every changed test directory, one file per process; lint if present.
2. Sim run of a 1on1 and an ignore scenario; one real-Slack pass with the Brojev `default` profile in the test channel: `/help`, `/model`, a non-owner post in a locked thread, one OAuth paste-back, one approval card then expanded record. Record what Slack actually did for the cases the design lists as unverified (thread with no replies, user not in channel).
3. Bump to the next `-rc.N`, notes under the stable name, push the branch, open the PR (mirror the repo PR template, leak scan the PR text), wait for CI including `codecov/patch`, squash-merge on green, tag the RC, and deploy to the box through vps-hardening with a backup first (that repo's own runbook).
