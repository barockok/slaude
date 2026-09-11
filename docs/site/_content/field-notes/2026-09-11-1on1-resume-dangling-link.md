# /1on1 resume amnesia, again: a dangling symlink `existsSync` called "missing"

**Date:** 2026-09-11

## Symptom

Start a thread, let it go idle, come back and pick it up inside `/1on1` — the
agent has no idea what was said before. No error, no warning, nothing in Slack.
Ordinary (unlocked) threads resume fine. This is the same user-visible failure
as [2026-06-11 — /1on1 transcript sharding](2026-06-11-1on1-transcript-sharding.md),
which was fixed by symlinking `projects/` out of the per-initiator config home.

## Root cause

The fix was right; its idempotence check was not.

`ensureInitiatorConfigDir` decided whether the `projects/` link needed
(re)creating with `existsSync(dstProjects)`. **`existsSync` follows symlinks.** A
link whose target has gone away therefore reports `false` — "nothing here" —
even though the link itself is very much there:

```
existsSync(dangling link) = false
lstat says symlink        = true
symlinkSync(target, link) → EEXIST
```

So the repair branch that *does* handle a wrong target was unreachable for the
one case that matters, the create branch ran instead, `symlinkSync` threw
`EEXIST`, and the `catch { /* best-effort */ }` swallowed it. The dangling link
survived every subsequent boot, forever.

A dangling `projects/` means the locked child has nowhere to write its
transcript. Every `/1on1` resume then misses — and a resume miss is deliberately
invisible: `#startSession` clears `claude_started`, reboots seeding
`--session-id`, and `#fanout` suppresses the `result(is_error)` so the
self-healing migration doesn't scare anyone. Correct for the case it was written
for; total silence for this one.

How a link goes dangling: `agentConfigDir()` used to return
`$SLAUDE_HOME/.claude` and now returns `~/.claude`. Initiator homes seeded
before that change point at the old path. While the old directory still existed
the stale-target branch healed them; once it was gone, they were stuck.

The same defect sat in the `plugins/` link (`!existsSync(dstPlugins)`), where it
costs a locked session its skills and plugins instead of its memory.

Second, narrower hole: a *real* `projects/` directory in an initiator home (an
operator who used `/1on1` before June 11) was deliberately left untouched to
avoid orphaning the transcripts inside it. But "left untouched" is permanent —
that user's every future lock flip loses context, which reads exactly like the
bug was never fixed. Heaviest `/1on1` users are precisely the ones with such a
home.

## Fix

- `ensureSymlink(target, link)` — one lstat-based helper, used for both
  `projects/` and `plugins/`. It sees the link rather than the link's target, so
  absent / correct / wrong-target / dangling are four distinct states instead of
  two. Failures `console.warn` instead of vanishing.
- Legacy real `projects/` dirs now **migrate** rather than sit there: contents
  are merged into the base transcript home and the path is replaced with the
  link. The merge never overwrites — a session id present in both homes keeps
  the base copy (that is what unlocked turns read) and the legacy copy is parked
  under `projects.legacy-<ts>/`, never deleted. `rename` with a `cp`+`rm`
  fallback, since `$SLAUDE_HOME` and the config home can be different mounts.
- The resume miss is no longer silent *in the logs*: it logs at `warn` with the
  session id, the `CLAUDE_CONFIG_DIR` in force and the cwd. The Slack-side
  suppression stays — the user shouldn't see an expected self-heal — but an
  operator now has one line naming the transcript home that came up empty.
- `scripts/debug-1on1.ts` reports transcript-home health (kind, target, whether
  it resolves, parked dirs), so the state that caused this is directly
  observable on a live deploy instead of being inferred.

## Lesson

`existsSync` on a path you are about to `symlink` answers a different question
than the one you are asking. Ask about the link with `lstat`; `existsSync` asks
about what it points at. And when a self-healing path is deliberately silent to
the user, it has to be loud somewhere — this was invisible for three months
because nothing recorded that a thread had just lost its history.
