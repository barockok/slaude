---
title: "State review at rc.49: the feature set is wide enough, the gap is proof"
date: 2026-11-28
---

# State review at rc.49: the feature set is wide enough, the gap is proof

**Date:** 2026-11-28
**Status:** review only. No code changed. The real gaps are filed as issues #256 to #262.

## Why this review

`v0.46.0-rc.49` was cut the same day. The question was whether to keep building (an eval
framework next) or to run this version on an instance first. The review read the specs, plans,
field notes and open issues, then checked every gap it found against the code on main, because
several documents were known to be behind the code.

## Verdict

The feature set is wide enough. The teammate epic (phases A, B, R, C, D, E) has every task
done, and platform phase 1, memory places and boxes have landed. What is missing is proof that
it behaves: no stable release since `v0.44.0`, several features that have only run in tests,
and no eval process. The decision: run rc.49 on an instance now, and build a thin eval beside
the soak, not before it. A soak finds real failures, and those become the eval cases. Building
the full harness first means guessing what to measure.

## Gaps confirmed against the code

| Gap | Evidence on main | Issue |
|---|---|---|
| No eval harness | no `src/eval`, no eval session kind; a design draft exists on a local branch | #256 |
| No stable release | latest stable tag is `v0.44.0`; 0.46.0 has 47 candidate tags | #257 |
| Half-rolled flags | defaults in `src/config/env.ts`: memory boundaries `shadow`, access source `shadow`, person slices `off` | #258 |
| `memory_get` and `memory_list` not filtered by place | the conversation filter exists only in `src/knowledge/gather.ts` | #259 |
| Race on a wake creating a `shared` page | `createsOnly` checks existence, the write is a separate step with no lock | #260 |
| Platform phase 2 not built | no memory versions, no cron run records, no cost in any console page | #261 |
| Shipped but never run for real | per-place nightly review and lessons upkeep, the `/1on1` DM place, the move job, boxes on a real model | #262 |

## What turned out to be stale, not a gap

The first pass listed these as open problems. The code says otherwise.

- **#200, upload path is node-relative.** Fixed by the direct upload path (`upload_begin`,
  `upload_complete`, `src/node/upload.ts`). The issue was never closed.
- **#247, memory leaks across channels.** Addressed by rc.45 to rc.48. Still open, no comment.
- **#201, a thread under an agent root message loses context.** Probably fixed by the thread
  head (rc.28) and by classifying every message (rc.43). No test names the exact case, so it
  needs one live check before closing (listed in #262).
- **The epic progress table** in `docs/superpowers/specs/2026-10-25-teammate-agent-epic-design.md`
  still says "unreleased" for phases that shipped.
- **`CLAUDE.md`** still lists sandboxing as deferred and the scope as Slack only. Boxes landed
  in rc.49, and the memory design is written for any surface.

The lesson: an open issue or a progress table is a claim, and the review was wrong about three
of seven "open bugs" until it read the code. Check the code before counting a gap.

## Review of the eval design draft

The draft (`docs/plans/2026-11-24-eval-process-design.md`, on a local `eval-process` branch,
not pushed) is strong on plumbing. It uses the real turn path (`queueDispatch` and the signed
job token), derives "eval" from the session instead of trusting the caller, makes the tool
plane deny by default, builds the trace from tool-plane records, and pairs results only when
the case definition hash matches.

The feedback is about what it measures and what it costs before the first score.

1. **It misses the three behaviours most left to the model.** The engage classifier runs on
   the gateway before dispatch, so an eval that starts at dispatch never exercises it. Eval
   mirrors a `slack` turn, and a wake boots a different agent. Memory tools are stubbed, so
   place scoping never runs. A cheap separate eval fits the first: replay logged
   conversation-log entries through the classifier and score against labels, with no session.
2. **Slice 0 is the riskiest part and comes before any value.** It adds `isEvalSession()` at
   about 17 hand-kept guard points in the agent loop of a production gateway. A throwaway
   stack (the fake Slack and HA harness, a real model, the same persona repo) is isolated by
   construction. Keep the runner, graders and data model; defer the in-production session
   kind until the scores prove useful.
3. **It is behind main.** Written before rc.45 to rc.49: migration `0054` is taken (latest is
   `0058`), it does not say which memory place an `eval:` thread resolves to, it predates
   boxes (a natural lockdown for the eval node), and the fingerprint lacks the decision
   config, the box image digest and the SDK version.
4. **Cases belong in files.** Personas are already code. YAML cases beside `agent.yaml` get
   review and history for free, and the console can be a viewer later.
5. **No starter suite.** Promote-from-session is the last slice but the main source of cases.
   Seed 20 to 30 from `tests/integration-agent` and from incidents in these notes.
6. **The noise band is weak at three trials.** Only 3 of 3 against 1 of 3 flags a case.
   Compare at suite level with paired cases.

One claim in the draft was not confirmed: a drift between `NODE_CAPS` and the client's
capability header list. `NODE_CAPS` does include `shared-env/1`.

## Agreed order of work

1. Deploy rc.49 with boxes off and soak it.
2. During the soak, run the items in #262 for real.
3. Fix the two memory read holes (#259) in one candidate.
4. Turn memory boundaries on for every persona (#258), then promote 0.46.0 to stable (#257).
5. In parallel: commit and revise the eval draft, then a thin first version (#256).
6. Later: platform phase 2 (#261), boxes on a real cluster, removing the shadow paths.

## Limits of this review

It read documents, issues and targeted parts of the code. It was not a line-by-line audit.
The "never run for real" items come from earlier field notes and were not checked against a
live deployment's logs.
