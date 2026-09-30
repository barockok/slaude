# Nightly end-to-end suite with a mock LLM

Status: design, approved in conversation, pending written-spec review.

## Purpose

Prove, every night, that the horizontally scaled topology (multiple gateway
replicas, multiple node workers, multiple personas) handles real Slack traffic
correctly, including when parts of it are killed mid-turn. Everything is real
except the model: the LLM is replaced by a deterministic mock, which is what
makes a scripted crash at an exact point in a turn reproducible.

Success criteria:

- A GitHub Actions nightly runs the full suite with no model credentials.
- Real Slack in, real Slack out, on the scale topology from `deploy/k8s-scale`.
- The four HA behaviours below are covered, across personas and entry paths.
- A failure leaves enough evidence (logs, mock journal, Slack transcripts) to
  diagnose without re-running.

Out of scope for v1:

- A full MCP OAuth round-trip. Only the LLM is mocked, so `connect-mcp` scenarios
  stop at the auth-URL card. A fake OAuth provider is a later addition.
- Running the suite on pull requests. The matrix is too heavy; a smoke subset can
  follow once the nightly is stable.
- Load or latency budgets. `scripts/load` already owns that.

## Decomposition

Three sub-projects, built in this order. Each gets its own plan.

1. **Mock LLM server** (`e2e/mock-llm`), preceded by a spike.
2. **Cluster and Slack harness** (`e2e/harness`, `e2e/k8s`).
3. **Scenarios and nightly workflow** (`e2e/scenarios`,
   `.github/workflows/e2e-nightly.yml`).

## 1. Mock LLM server

### Build on aimock

Use CopilotKit's `@copilotkit/aimock` (MIT, actively maintained) as the engine
instead of writing a mock. It streams Anthropic Messages SSE including
`tool_use`, `input_json_delta` and thinking blocks, lets a response be a function
of the request (`predicate`, `ResponseFactory`), injects faults (429, 5xx,
malformed SSE, mid-stream disconnect, latency) scoped per `X-Test-Id`, exposes
`GET /__aimock/journal`, and mounts extra routes with `mount(path, handler)`.
Compared alternatives: `llm-mock-server` (young, pulls fastify and zod),
MockServer (JVM), `mock-llm-service` (built for load tests).

Known gaps to close in the spike: no `count_tokens` route (add one with `mount`),
and Bun compatibility is undocumented (run it under Node in its own container).

### Shape

- `e2e/mock-llm/` holds pure scenario logic (`core/`) and a small server that
  embeds `LLMock` for happy-path content, behind a front HTTP handler. aimock's
  `predicate` and `ResponseFactory` receive only the request body, not HTTP
  headers, so the front handler owns everything that depends on the tag or
  headers: fault injection, `count_tokens`, and a request journal.
- Image: `node:alpine` plus one bundled server file (aimock included), built with
  `bun build --target=node`.
- Deployed as its own Deployment with 2 replicas. It is therefore stateless by
  construction; nothing may rely on which replica answers.

### Statelessness rule

A response is a pure function of the request. This is required because a turn
killed on one node is re-delivered to another and sends the same history again.

- Scenario selection: a tag in the most recent user message that carries one,
  e.g. `[[mock:multi-tool n=3]]`. "Most recent" rather than "first" so a resumed
  thread's later turn, which carries its own tag, selects its own scenario. Tool
  results count toward the phase only when they follow that message.
- Phase: derived from `messages[]` (the trailing `tool_result`, the count of
  assistant `tool_use` blocks). Never from aimock's `sequenceIndex` or any
  server-side counter.
- Persona: read from a `Persona-ID: <id>` line that each test persona's
  `SOUL.md` contains, and echoed in replies, so tests can assert the right
  identity answered.
- Faults: derived from the tag and applied by the front handler. The spike showed
  the client's `x-stainless-retry-count` stays at 0 after a 529, so it cannot
  drive retries. Instead the front handler keeps a per-(system prompt, history)
  attempt counter: the one deliberate stateful exception to this rule. It is
  fault-only and never changes reply content. Consequence for replicas: a retry
  may land on another replica, so fault scenarios needing more than one attempt
  (`until-retry` of 2 or more) require a single replica or client-IP affinity,
  and test prompts must be unique per case and per persona.

### Spike (runs before any of the above is built)

Question: does the real Claude CLI, driven by slaude's `AgentManager`, complete a
multi-tool turn against aimock?

Probe (scratchpad only, nothing committed): start aimock with one
`multi-tool n=2` scenario and a stub `count_tokens`; run one real turn with
`ANTHROPIC_BASE_URL` pointed at it and a dummy key; read the journal.

Answers required:

- Which endpoints the CLI hits (`/v1/messages` only, or also `count_tokens`, a
  small-model title call, telemetry).
- Whether the second request's `messages[]` carries the `tool_result`.
- Whether `x-stainless-retry-count` appears after the mock returns 529 once.
- Whether `ANTHROPIC_CUSTOM_HEADERS` can inject `X-Test-Id` (optional).
- Whether aimock runs under Bun or only Node.

Decision rule: if the CLI completes the turn and the retry header appears, build
on aimock. Otherwise write a thin custom `/v1/messages` server (about 300 lines)
and keep the scenario shapes below. Time-box: about an hour.

## 2. Cluster and Slack harness

### Cluster

Reuse `deploy/k8s-local` (minikube, two gateways, two nodes, Postgres, Redis,
shared volume). It references the production `deploy/k8s-scale` manifests, so the
suite runs what ships. `up.sh` already forwards `ANTHROPIC_BASE_URL`; point it at
the in-cluster mock Service. An `e2e/k8s` kustomize overlay adds the mock
Deployment. Crash helpers are lifted from `verify-ha.sh` (SIGKILL through the
container runtime, since `kubectl delete --force` only exercises the graceful
path).

### Slack

Real Slack test workspace, HTTP events mode (`SLAUDE_SLACK_MODE=http`), which the
HA gateways require.

- One Slack app per persona, created once by hand. Each app's Events and
  Interactivity URLs are set once to the fixed tunnel hostname.
- Apps are registered into the `slack_apps` registry non-interactively with the
  existing `slack-app add` CLI, from secrets, inside a gateway pod. No browser
  OAuth install in CI.
- The driver is a Slack **user** token, because the bot ignores its own posts. It
  posts real messages, mentions and button clicks, and reads real replies
  (`conversations.replies`).
- Each run creates its own channel and archives it at the end.

### Tunnel

A Cloudflare **named tunnel with a fixed hostname**. A quick tunnel with a random
URL would force rewriting every app's URLs through the manifest API, whose config
token has a single-use rotating refresh token that a workflow cannot persist
without a PAT or GitHub App.

- `cloudflared` runs on the runner, forwarding to the gateway Service through
  `kubectl port-forward`.
- Ingress rules allow only `/slack/events` and `/slack/interactions`. The panel,
  API and OAuth routes are never exposed.
- Slack signature verification remains the authentication for those two routes.
- One connector at a time. The workflow's concurrency group prevents two runs
  sharing the tunnel; a developer must not start a second connector on the same
  tunnel, since Cloudflare would load-balance between them.

## 3. Scenarios

Every scenario is a pure function of the request (see the statelessness rule).
Tool names are the real ones the agent has today.

Building blocks: `say`, `tool(name, args)`, `think`, `stream(chunks, tps)`,
`ttft(ms)`, `fail(status)`, `drop(afterEvents)`, `malformed`, `hang`.

| Tag | Mock behaviour | Real path exercised | HA use |
|---|---|---|---|
| `echo` | Reply with persona name and echoed text | Ingress, engagement, threaded reply | Baseline; persona identity |
| `multi-tool n=K` | K sequential tool calls, then a summary | Tool loop, status line | Kill the node at tool *i* of K |
| `long-stream chunks=N interval=<dur>` | Long slow stream | mrkdwn conversion, message splitting | Window for a mid-stream SIGKILL |
| `think` | Thinking blocks, then answer | Thinking is not posted to Slack | Leak check |
| `approval` | Call `surface__request_approval`; final text depends on approve/deny result | Approval gate, Block Kit buttons | Click lands on the replica that did not post the card |
| `surface-tools` | `surface__react`, `edit`, `upload`, `get_history` | Slack surface tools | Same tools from either replica |
| `cron-add` / `cron-fire` | Add a near-term job; the fired turn replies | Cron leader election, claim-before-dispatch | Kill the leader; occurrence fires exactly once |
| `kb-memoize` / `kb-recall` | Write a fact in turn 1, recall it in turn 2 | Brain on Postgres (`slaude_brain`) | Turn 2 on a different replica or node |
| `skill-write` / `skill-use` | `write_skill`, then use it | Skills on the shared volume | Visible on the other node |
| `resume` | Second turn in the same thread | Session resume, transcript on shared volume | Mock checks prior turns are in `messages[]` |
| `connect-mcp` | Call `connect_mcp` | Connect broker up to the auth-URL card | Callback replica differs from start replica |

Faults are orthogonal tag parameters, so any scenario combines with any fault:
`fail=429|500|529 until-retry=N`, `drop=K` (cut the stream after K events),
`malformed=1`, `hang=1`, `ttft=<duration>`, `interval=<duration>` (pause between
streamed events), `overflow=1` (400 prompt-too-long, for the token-budget path).
Precedence: hang, overflow, fail, drop, malformed.

### Multi-persona

The catalogue runs against at least two personas, each with its own Slack app.
Two journal-based checks:

- `whoami`: each persona's system prompt reached the model, and only that one.
- Isolation probe: seed a marker in persona A's memory, assert no request from
  persona B ever contains it.

### Variation matrix

A table-driven runner expands scenario × persona × entry path (DM, channel
mention, thread reply, `/1on1`) × fault profile × kill point. Kill points: before
the first token, mid-stream, during a tool, after the final text but before the
Slack post. Kills are triggered from the journal or the Slack thread (for example
"journal shows request 1 for this thread, so SIGKILL the node holding it").
Threads run in parallel under a concurrency cap sized to Slack rate limits.

### Assertions on every HA case

- Exactly one final reply in the thread; no duplicate.
- After a node kill, the journal shows the same history sent twice.
- No error card is left behind.

## 4. Nightly workflow

`.github/workflows/e2e-nightly.yml`

- Triggers: `schedule` (03:00 UTC) and `workflow_dispatch` with a scenario filter
  and matrix-subset input, so a failed subset can be re-run cheaply.
- `concurrency: e2e-nightly`, `cancel-in-progress: false`; `timeout-minutes: 90`;
  `runs-on: ubuntu-latest`.
- Steps:
  1. Install minikube and kubectl; build the slaude and mock-llm images inside
     minikube.
  2. `deploy/k8s-local/up.sh` with `ANTHROPIC_BASE_URL` set to the mock Service
     and a dummy key; apply the `e2e/k8s` overlay.
  3. Start `cloudflared` with the named-tunnel token.
  4. Register personas with `slack-app add` inside a gateway pod.
  5. Run `verify-ha.sh` then `verify-turns.sh` as cluster sanity.
  6. Run `bun test e2e/`: create the channel, expand the matrix, drive cases,
     assert on Slack, the journal and cluster state.
  7. Always: archive the channel, collect artifacts, tear down.
- Artifacts on failure: pod logs, mock journal, Slack thread transcripts. A
  pass/fail matrix goes in the job summary. A failing nightly opens or updates a
  single tracking issue.
- Secrets: per-persona bot token and signing secret, the driver user token, the
  tunnel token. No model key. The repo is public: workspace and team identifiers
  live in secrets and variables, never in committed files.
- No blind retries. A failing case is recorded with its evidence; the subset is
  re-run through `workflow_dispatch`.

## Risks

- **CLI vs mock fidelity.** The Claude CLI may call endpoints or send headers the
  mock does not expect. Mitigated by the spike; fallback is a thin custom mock.
- **Slack rate limits and flakiness.** Concurrency cap, one channel per run, and
  evidence capture on failure. Slack outages fail the nightly and are told apart
  from product failures by the sanity steps running first.
- **Runner capacity.** minikube needs about 3.5 GB; `ubuntu-latest` on a public
  repo has headroom, but the matrix runtime must stay inside the 90-minute limit.
- **Killed-node lock TTL.** A killed node never releases its session lock, so a
  re-delivered turn waits out that lock's TTL (10 minutes; see the 2026-09-29 cron-claim and turn-failover field note).
  Kill-scenario timeouts must allow for it; this is a latency bound, not a bug.
- **Baseline test flake.** One unidentified failure appeared in one of two full
  `bun test` runs at the start of this work. It is unrelated but should be
  identified before the nightly's own results are trusted.

## Rollout

1. Spike; decide aimock or custom.
2. Mock server plus the baseline scenarios (`echo`, `multi-tool`, faults),
   testable locally with the existing sim harness and no cluster.
3. Cluster and Slack harness; one persona, baseline scenario, manual dispatch.
4. Add HA scenarios (node loss, gateway loss and leader failover, cross-replica
   state), then multi-persona.
5. Enable the schedule; add the tracking-issue reporter.

No release candidate is required: the work is test and deploy tooling and does not
touch `install.sh`, the dist layout, the DB schema or the agent loop.
