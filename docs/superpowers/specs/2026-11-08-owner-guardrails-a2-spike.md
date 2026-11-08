# Owner guardrails A2 spike: how a tool `approve` can hold a call

Status: done, decides the approach for phase A2 (rc.10). Parent design:
`2026-11-08-owner-guardrails.md`, section 4 ("approve (phase A2)").

## Question

A tool rule with `action: approve` must hold the call until an approval card is
decided, and a timeout or any error must be a deny, never an allow. The design
named two candidates:

- (a) the PreToolUse hook awaits the gateway's permission resolver (the card)
  itself, with the matcher's `timeout` set above the card's life;
- (b) the hook returns `permissionDecision: "ask"` and `canUseTool` raises the
  card, if that reaches `canUseTool` under `bypassPermissions`.

The design assumed the SDK's hook timeout defaults to 60 s and that a timed-out
hook lets the tool run.

## Method

`@anthropic-ai/claude-agent-sdk` 0.3.173 as pinned in `package.json`, the
bundled CLI binary, driven through `query()` against a local fake of the
streaming Messages API (`tests/spike/fake-messages-api.ts`): the first request
answers with one `Bash` tool call (`touch <marker>`), the next ends the turn.
Whether the marker exists says whether the tool ran; the fake records the
`tool_result` the CLI sent back. Runner: `tests/spike/sdk-run.ts`.

## Results

| Case | Mode | Result |
|---|---|---|
| matcher `timeout: 10`, hook awaits 4 s, returns deny | bypass | denied, our reason returned |
| no matcher timeout, hook awaits 65 s, returns deny | bypass | denied after 65 s (no 60 s default for in-process callback hooks) |
| matcher `timeout: 90`, hook awaits 65 s, returns deny | bypass | denied after 65 s |
| matcher `timeout: 4000`, hook awaits 1 s, returns deny | bypass | denied (a large timeout is accepted) |
| matcher `timeout: 2`, hook awaits 5 s | bypass | the hook's `signal` aborts at 2 s; the tool does not run; the tool result is the CLI's "the user doesn't want to take this action" interrupt text |
| matcher `timeout: 3`, hook awaits 5 s, returns allow | bypass | the late allow is ignored; the tool does not run |
| hook throws | bypass | the tool runs (an error falls through) |
| hook A allows after 2 s, hook B denies at once (same matcher) | bypass | denied with B's reason; both started at the same millisecond (hooks run concurrently, across matchers too) |
| hook returns allow, `canUseTool` would deny | default | the tool runs, `canUseTool` is not called |
| hook returns ask, `canUseTool` denies | bypass | `canUseTool` called once with `decisionReason` = the hook's reason; denied |
| hook returns ask, no `canUseTool` | bypass | denied with the hook's reason |

The two 65 s cases were run once by hand (they are too slow for CI); every
other row is pinned by `tests/spike/sdk-hooks.test.ts`, so an SDK upgrade that
changes one fails CI.

## Decision

Approach (a): the owner-guardrails hook awaits the card.

- Both approaches work on this SDK. (a) keeps the decision inside the hook:
  the only SDK behaviour beyond A1's deny contract that it relies on is that a
  hook may wait as long as its matcher allows. (b) relies on `ask` keeping its
  meaning under `bypassPermissions` and on `canUseTool` not short-circuiting
  (our own `permissionPolicy` auto-allows whole namespaces and
  `SLAUDE_AUTO_ALLOW_TOOLS`, so it would need a side channel to force a card);
  a change there would turn an approve rule into an allow.
- The design's premise was wrong for this SDK: there is no 60 s default for
  in-process callback hooks, and a timed-out hook does not let the tool run.
  Neither is relied on. The PreToolUse matcher carries an explicit `timeout`
  (the approve cap plus a 60 s margin), and the hook owns an inner deadline
  strictly shorter than it: when the deadline passes the hook returns deny
  itself, with the rule's message.
- A thrown hook falls through to allow, so the approve path catches every
  error and returns deny.
- An approval returns `allow` from the hook, which skips `canUseTool`: one card
  per call, not a second ordinary permission card in `default` mode.
- Hooks run concurrently, so another hook (the skill gate, the files hook) can
  deny a call while its owner card is open. The card is then answered by
  nobody's action; the call is already refused. Accepted.

## Deadlines

- `SLAUDE_GUARDRAIL_APPROVE_TIMEOUT_SEC` (default 600, at most 3600, the
  permission card's own TTL): how long an owner tool card waits. The matcher
  timeout is this cap plus 60 s; the inner deadline is the cap.
- Nodes: the job token lifetime (15 minutes) is also the node's hard turn
  deadline (`turnTimeoutMs`, measured from the start of the turn). The token is
  not extended. The node hands the session's turn deadline to the hook, and
  the inner deadline is the earlier of the cap and that turn deadline less 30
  s; a card opened late in a turn therefore gets less time, and a card can
  never outlive the token that polls it.
- In a wake or a background pass nobody is in the turn: approve is a deny at
  once, before any card (the hook checks, and the gateway's resolver wrapper,
  the node resolver and the gateway's `can_use_tool` route refuse the same).

## Node path

The node's hook calls the node permission resolver with an owner-approval
marker, which skips the local auto-allow policy and posts
`/v1/tools/runtime/can_use_tool` with `force_card: true` and
`rule_id: "<slug>#<rule id>"`. The gateway re-evaluates the rule from its own
verified snapshot (the rule exists, applies to the token's agent in the
token's channel, is a tool `approve` rule and matches this tool name and
input) before it opens the card; otherwise the call is denied. A node cannot
force a card the owner's set does not ask for, and cannot skip one by leaving
the flag off (its hook is the only place that asks).
