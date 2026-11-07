# Proactiveness that is simple to turn on and gets things done

Date: 2026-11-03. Follows `2026-11-02-heartbeat-wake-design.md`. Status: on `feat/proactive-simple`, live on one deployment as a patched rc.12.

## Goal

Writing `Enabled: yes` in a place in a SOUL is all it takes for an agent to work there on its own, and when it does, a person sees finished work and clear decisions, not lists of ideas and repeated questions.

## Evidence (live deployment, 2026-11-01 to 2026-11-03)

| Finding | Evidence | Cause |
|---|---|---|
| Wakes could not see answers | An agent's notes at 14:01Z: "zero approvals"; the approval was posted at 10:45Z | A wake is a fresh session and nothing read Slack |
| Wakes could not save anything | `kb operation "put_page" is not allowed from this channel`; the agent then wrote "no write tool available" into its notes | The wake's initiator is the agent's own id, so the gate read it as a person in a public channel |
| Nothing was made | 11 posts in 3 days, all concepts or status; approved work had no assets | Prompt and checklist reward proposing, and nothing defines a finished wake |
| Threads started from nothing | An agent, mentioned about its own approved concepts: "No assets found, no prior context" | Only replies under a post get context, and notes belong to wakes |
| Silence read as blindness | An agent told the manager three times that it could not read a channel | No read of a working channel by default |
| Questions piled up | Three batches a day with no answers | No state for "still waiting" |
| Too many settings | `Enabled`, `Wake`, `Highest`, `Cooldown`, `Max per person per day`, `Max per day`, plus a required `self/heartbeat` page; `Enabled` alone did nothing visible | Each fix added a knob |

## Decisions

- `Enabled: yes` is the only setting needed. The mandate is the job and the authority. `Wake`, `Highest`, `Cooldown` and the old cap name still parse, and only narrow.
- `self/heartbeat` is optional: mandates plus the page are the job, and a change to either wakes the agent.
- Code reads Slack before the model call and hands the wake what happened (`wake-activity.ts`).
- A wake writes to the agent's own memory like any background turn.
- The first turn of a thread in a working place gets the agent's recent posts, notes and folder (`proactiveWorkBlock`).
- `proactive_post` needs only `text`.
- The prompt states what counts as a finished wake and what does not. It is a request, so results are checked outside the model (below).
- Unchanged: external `Watch:` sources stay behind the locked triage round, restraint stays in code, "ask first" stays in the mandate.

## Risks accepted

- Upgrade: an existing persona with `Enabled: yes` starts waking. Fine for this deployment. Upstream release needs a release note, or a migration default.
- Channel text now reaches a full-tools turn as data. Only channels the operator turned on are read, the prompt says only the manager or an approver can approve, and that limit is prompt-level, as in any thread.
- Rendering in a wake spends outside the model budget (GPU, paid APIs), as the wake design already notes.

## Evaluator (locked before the live runs)

A scenario passes only on evidence from Slack, the brain or transcripts, across at least two wakes. Do not edit these to fit a result.

| # | Check | Evidence |
|---|---|---|
| E1 | A place with only `Enabled: yes` and a mandate wakes, with no heartbeat page | log `woke`, no page in the brain |
| E2 | Work is finished: an artifact exists and any post points to it | file or KB page exists; post names it |
| E3 | `memory_save` (formerly `kb_memoize`) in a wake succeeds | transcript has no refusal; page in the brain |
| E4 | A reply posted since the last wake appears in that wake's activity, and the notes agree | envelope and notes |
| E5 | An approval in a thread leads to the approved thing being done | thread and artifact |
| E6 | A new thread mentioning the agent knows its recent work | reply content |
| E7 | An "ask first" item is proposed once and not done without approval | no side effect; one ask |
| E8 | An unanswered question is not repeated and not stacked | posts across two wakes |
| E9 | With nothing due, nothing is posted and no model call happens while idle | posts; gate metric `idle` |
| E10 | No wake hits a cap or errors, within the USD cap | `background_runs` |

Does not count: unit tests alone, the agent saying it did something, a post describing work with no artifact, a single run.
