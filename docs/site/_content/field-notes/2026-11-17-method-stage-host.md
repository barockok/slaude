# Running a workflow method stage: fresh context, artifact submit, commit

Status: design, nothing built yet. This note records what the chat host must add so an external workflow service can run role-based "method" stages (analyst, product manager, architect, developer, QA) on slaude, and why the first idea (reuse the thread session) does not work.

## Why a method stage needs an isolated run

The workflow service assembles one self-contained prompt per stage: project rules, the stage persona (a markdown file that says who the agent is for this stage), the stage instructions, the request, the approved artifacts from earlier stages, clarification answers, and every rejection note. It asks the chat host to run that prompt in a fresh context. Two runs of the same request then see the same inputs, and differ only by model sampling.

The workflow turn handler sends each turn into the thread's session. That session adds four inputs the prompt does not contain:

| Extra input | Where it enters |
|---|---|
| The deployment soul (`SOUL.md`) | `soulSystemBlock` in the session system prompt |
| Episodic memory | `memory.prefetch` at boot, `memory.syncTurn` after each turn |
| Self-written skills | the home plugin and the `slaude_skills` MCP server |
| Thread history | the session itself |

Any of these makes the same request produce a different stage output depending on what the thread discussed earlier. Method stages therefore cannot run in the thread session.

## Options for the isolated run

| Dimension | A. Standalone SDK `query()` per turn | B. Flag on session boot | C. Second session row |
|---|---|---|---|
| Isolation | By construction: nothing is mounted | Five skips must stay in sync (memory prefetch, soul block, plugins, skills server, turn flush) | None: a cron-style session still gets soul, memory and skills |
| Existing code touched | None, one new module | Five points in the boot path | Small, but needs B's flag too |
| Session table | No row | Thread row | New row; the unique key is `(team, channel, thread_ts, persona_id)` |
| Sandbox identity | Passed explicitly | Inherited | New unless overridden |

The recommended option is A. The knowledge ingest path already runs a standalone `query()` with a plain-string system prompt, `settingSources: []`, strict MCP config and a scrubbed child environment, so the pattern exists and has a test seam (an injectable query function).

## What the host adds

```
 chat thread (people)             slaude                          workflow service
 ────────────────────             ──────                          ────────────────
                                                                  stage prompt =
                                                                   rules + stage persona
                                                                   + approved artifacts
                                  /workflow/v1/turns ◄──────────  { context:"fresh", prompt,
                                       │                            artifact:{...} }
                          context == "fresh" ?
                            no ─► inject into thread session (unchanged)
                            yes ─► fresh runner
```

```
 thread session (normal)                 fresh runner (one per stage turn)
 system prompt = soul, memory,           system prompt = the workflow prompt only
   skills, history                       no session row, no memory writes
                                         tools: reply, submit_artifact,
                                                sandbox (code stages only)
```

1. **Turn body.** The handler reads `context`, `artifact`, `promptHash`, `model` and `effort` in addition to the five fields it reads today. A `fresh` turn returns `200` at once and runs asynchronously, because the caller times a request out at 15 seconds.
2. **Submit tool.** `submit_artifact` posts `{content, outcome, checklist}` to the workflow service with the turn's stage and attempt. A `422` comes back as a tool error listing every problem, so the agent fixes it in the same turn. The service checks mandatory template sections, leftover placeholders, the cap on open clarification markers and the checklist before a person ever sees the artifact.
3. **Approval card.** It shows the artifact, the checklist answers and the open questions. With open questions it offers an Answer modal instead of Approve. The check that the clicker is the run's starter or a participant stays first, and the card resolves only after the service accepts the call.
4. **Commit callback.** `POST /workflow/v1/runs/:id/commit` with `{requestId, path, content, message}` writes the approved artifact into the run's repository and commits it. It returns `{sha}`, or `{skipped}` when the run has no sandbox, and a repeated `requestId` returns the first result. The commit message carries the request id as a trailer. A repeat finds that commit with `git log --grep` and returns its sha, so idempotency needs no table.

## Findings that shape the commit path

| Fact | Consequence |
|---|---|
| The sandbox server exposes `bash`, `read`, `write`, `edit`, `glob`, `grep`, `git_push` and `git_fetch`. It has no commit tool and no REST route for writes. | The commit runs through `bash` as a JSON-RPC `tools/call`. |
| Any `tools/call` creates the sandbox and clones every configured repository. | "No sandbox" cannot be detected by asking the server. It comes from slaude's own per-thread sandbox flag. |
| `write` refuses to overwrite a file that was not read in the same session. | The commit writes the content through `bash` on stdin. |
| The `git_push` tool accepts only `factory/*` branches. | The commit step checks the current branch matches `factory/*` first. |
| slaude has no generic MCP `tools/call` client. | A small helper is added, modelled on the existing out-of-turn sandbox teardown call. |

Code stages need one more rule. The sandbox server keys a sandbox by the session UUID in a request header. A fresh run that sends a new UUID reaches an empty sandbox and loses the repository cloned earlier in the thread, so the runner must send the thread session's UUID.

## Rollout

The handler stays behind the workflow flag plus a new sub-flag. With the sub-flag off, a `fresh` turn receives `409` instead of silently running in the thread session. Non-method stages never set `context: "fresh"` and keep their current path. Because the change touches the agent loop, it ships as a release candidate first. It needs no database migration: the stage spec lives in memory for the turn, and commit idempotency lives in git.

Order: turn body behind the flag; fresh runner and submit tool for stages that need no sandbox; card changes; commit callback; sandbox-backed stages; release candidate and soak.

## Known limit

A fresh turn runs asynchronously in the pod. If the pod restarts mid-turn, the turn is lost, and the request id is already recorded, so the caller's retry is answered as a duplicate. The stage then waits for its gate timeout or a rejection. Resuming unfinished turns on boot is a separate durability change, and a turn-status column would be the only reason to add a migration later.

## Open questions

- Does the runner need the session's Slack routing, or can it post through the bot client as the existing workflow `post` callback does?
- Should commit run when sandbox mode is off but the pod holds a checkout? The default is `skipped`.
- Should the whole turn also bypass the deployment soul, or only memory and skills? The host contract lists the soul as forbidden input, so the default is to bypass it.
