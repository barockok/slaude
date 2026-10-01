# Nightly end-to-end suite with a mock LLM

Status: design, approved in conversation. Amended after the mock-LLM plan:
the matrix now runs against a fake Slack server, with a small real-Slack canary
alongside it (see sections 2 and 4). Pending written-spec review.

## Purpose

Prove, every night, that the horizontally scaled topology (multiple gateway
replicas, multiple node workers, multiple personas) behaves correctly under
realistic Slack traffic, including when parts of it are killed mid-turn. The
gateways, nodes, queue, locks, cron, Postgres and Redis are the real deployment.
Two edges are replaced by deterministic fakes so a scripted crash at an exact
point in a turn is reproducible: the model (a mock LLM) and Slack (a fake Slack
server). A separate canary keeps one path on real Slack so the fake cannot drift
unnoticed.

Success criteria:

- The full HA matrix runs in GitHub Actions with no model credentials and no
  Slack credentials or tunnel.
- It runs on the scale topology from `deploy/k8s-scale`, with the real gateway
  HTTP ingress path (signature verification, per-request app lookup) exercised.
- The four HA behaviours below are covered, across personas and entry paths.
- A failure leaves enough evidence (logs, mock-LLM journal, fake-Slack call log
  and thread transcripts) to diagnose without re-running.
- A real-Slack canary proves one persona round-trips on a real workspace.

Out of scope for v1:

- A full MCP OAuth round-trip. The model and Slack are faked, so `connect-mcp`
  scenarios stop at the auth-URL card. A fake OAuth provider is a later addition.
- Load or latency budgets. `scripts/load` already owns that.
- Slack-side behaviour that only real Slack can show (Block Kit validation,
  mrkdwn rendering). The canary samples it; the matrix does not claim it.

## Decomposition

Three sub-projects, built in this order. Each gets its own plan.

1. **Mock LLM server** (`e2e/mock-llm`), preceded by a spike. Built and in review.
2. **Cluster and fake-Slack harness** (`e2e/fake-slack`, `e2e/harness`,
   `e2e/k8s`), including the small `SLAUDE_SLACK_API_URL` seam in the gateway.
3. **Scenarios and workflows** (`e2e/scenarios`,
   `.github/workflows/e2e-ha.yml` for the matrix and
   `.github/workflows/e2e-slack-canary.yml` for the real-Slack canary).

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
- Deployed as its own Deployment. Reply content is stateless, so any replica
  answers any request identically; but fault attempt counting is per process (see
  the statelessness rule), so run one replica unless every fault case uses the
  default `until-retry=1`, and collect journals per pod rather than through the
  Service.

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

## 2. Cluster and fake-Slack harness

### Cluster

Reuse `deploy/k8s-local` (minikube, two gateways, two nodes, Postgres, Redis,
shared volume). It references the production `deploy/k8s-scale` manifests, so the
suite runs what ships. `up.sh` already forwards `ANTHROPIC_BASE_URL`; point it at
the in-cluster mock Service. An `e2e/k8s` kustomize overlay adds the mock-LLM
Deployment and the fake-Slack Deployment (one replica, since its state is in
memory). Crash helpers are lifted from `verify-ha.sh` (SIGKILL through the
container runtime, since `kubectl delete --force` only exercises the graceful
path).

### Why a fake Slack, and why not an existing tool

What the matrix proves is gateway, node, queue, lock and cron behaviour under
failure, not Slack's wire behaviour. A real workspace adds rate limits, outages, a
public tunnel and secrets without testing more of slaude, and Slack offers no API
for a user to press a Block Kit button, so a real-Slack driver could not drive the
approval scenarios anyway.

Existing tools were checked and none fits: `slack-mock` intercepts HTTP inside the
test process (our gateways run in other pods), has no request signing and returns
`{ok: true}` for unstubbed methods; `slack-testing-library` targets App Home views;
`@slack-wrench/jest-bolt-receiver` is an in-process Bolt receiver. The archived
`slackapi/slack-api-specs` OpenAPI is stateless and does not generate signed
inbound requests. So the fake is purpose-built (Bun/TypeScript, small).

### Fake Slack server (`e2e/fake-slack`)

An out-of-process HTTP service with three responsibilities.

**Web API, in memory.** The methods slaude calls today: `chat.postMessage`,
`chat.update`, `chat.postEphemeral`, `chat.delete`, `reactions.add`,
`reactions.remove`, `auth.test`, `users.info`, `conversations.replies`,
`conversations.info`, `conversations.members`, `conversations.setTopic`,
`conversations.setPurpose`, `search.messages`, `pins.add`, `pins.remove`,
`files.info` (and the file-upload calls the surface `upload` tool makes). State is
real: channels, threads, message timestamps, reactions, bot and human users. A
method outside the list answers `{ok: false, error: "unknown_method"}` and is
recorded, so a new slaude call fails loudly instead of silently succeeding.

**Inbound sender.** The fake plays Slack's side of the wire: it sends correctly
signed `POST /slack/events` and `/slack/interactions` to a gateway, using each
registered persona's signing secret, with real envelope fields (`event_id`,
`event_time`, `team_id`, `api_app_id`, `authorizations`). The target is explicit:
a specific gateway pod or the Service, so "the click lands on the replica that did
not post the card" is deterministic. Emulated Slack behaviours that matter for HA:
retry on a non-2xx or a slow acknowledgement (with `X-Slack-Retry-Num`, intervals
compressible for tests), duplicate delivery of the same `event_id`, delayed and
out-of-order delivery, and dropped events.

**Control API (`/__fake/*`).** For the test harness: create a channel or user, post
a message as a human, click a button (build and send the interaction payload for a
chosen card and target), read a thread and the ordered call log, and inject Slack
faults (429 with `Retry-After`, 5xx, slow responses, per method).

**Spec guard.** Responses and slaude's outgoing requests are validated against a
vendored, SHA-pinned subset of the archived Slack OpenAPI schemas for the methods
above, so a wrong argument slaude starts sending, or a response shape the fake
invents, fails the build. The licence of the spec repository is checked before
vendoring (decision for the plan).

**Seam in the gateway.** Both Slack clients are constructed with a token only
(`src/gateway/slack/http-transport.ts`, `src/persona/registry.ts`). Add an env var
`SLAUDE_SLACK_API_URL`, passed to `WebClient` as `slackApiUrl`, off by default.
This is the only production-code change in the whole effort.

**Personas.** Test personas are registered with the existing `slack-app add` CLI
inside a gateway pod, using generated app ids, team id, bot tokens and signing
secrets (random per run, shared with the fake). No real Slack credentials and no
browser OAuth install.

### Real-Slack canary

A small, separate check that the fake has not drifted. One persona on a real Slack
workspace (a free Slack Developer Program sandbox workspace is enough), HTTP events
mode, one round trip: an `@mention` in a channel and a threaded reply, plus a DM.
It uses a real bot token and signing secret, and a dedicated test user's user
token, because the bot ignores its own posts. It runs the mock LLM, not a real
model.

It needs public ingress, so it uses a Cloudflare **named tunnel with a fixed
hostname**. A quick tunnel with a random URL would force rewriting the app's URLs
through the manifest API, whose config token has a single-use rotating refresh
token that a workflow cannot persist without a PAT or GitHub App.

- `cloudflared` runs on the runner, forwarding to the gateway Service through
  `kubectl port-forward`.
- Ingress rules allow only `/slack/events` and `/slack/interactions`. The panel,
  API and OAuth routes are never exposed.
- Slack signature verification remains the authentication for those two routes.
- One connector at a time. The workflow's concurrency group prevents two runs
  sharing the tunnel; a developer must not start a second connector on the same
  tunnel, since Cloudflare would load-balance between them.
- Button clicks are out of the canary's reach (Slack has no API for them); the
  fake covers them with signed interaction payloads.

## 3. Scenarios

Every scenario is a pure function of the request (see the statelessness rule).
Tool names are the real ones the agent has today.

Building blocks: `say`, `tool(name, args)`, `think`, `stream(chunks, interval)`,
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

### Slack-side faults (fake Slack)

Injected through the fake's control API, independent of the model tags, so any
scenario combines with any Slack fault:

| Fault | What the gateway must do |
|---|---|
| Duplicate delivery of the same `event_id` (and of the same message `ts` under a new id) | Answer once; dedup holds across replicas |
| Slow or failed acknowledgement, so Slack retries (`X-Slack-Retry-Num`) | Acknowledge fast; no second turn from the retry |
| Dropped event | No reply, no crash, no stuck session lock |
| Delayed or out-of-order events within a thread | Replies stay in the right thread |
| `chat.postMessage` or `chat.update` returns 429 with `Retry-After` | Back off and post once; no duplicate after the retry |
| `chat.postMessage` returns 5xx once | Post once after the retry |
| Interaction payload delivered to the replica that did not post the card | The approval resolves exactly once |

### Multi-persona

The catalogue runs against at least two personas, each registered as its own fake
Slack app (own app id, bot user, signing secret). Two journal-based checks:

- `whoami`: each persona's system prompt reached the model, and only that one.
- Isolation probe: seed a marker in persona A's memory, assert no request from
  persona B ever contains it.

### Variation matrix

A table-driven runner expands scenario × persona × entry path (DM, channel
mention, thread reply, `/1on1`) × model-fault profile × Slack-fault profile × kill
point. Kill points: before
the first token, mid-stream, during a tool, after the final text but before the
Slack post. Kills are triggered from the mock-LLM journal or the fake's call log
(for example "journal shows request 1 for this thread, so SIGKILL the node holding
it"). Threads run in parallel under a concurrency cap sized to runner CPU; the
fake has no rate limits unless a case injects them.

### Assertions on every HA case

All Slack-side assertions read the fake's ordered call log and thread state.

- Exactly one final `chat.postMessage` in the thread; no duplicate.
- After a node kill, the mock-LLM journal shows the same history sent twice.
- No error card is left behind.
- No Web API call outside the known method list (the fake rejects it and the case
  fails).

## 4. Workflows

Two workflows, so a Slack outage or a canary failure never masks a product
regression in the matrix.

### HA matrix: `.github/workflows/e2e-ha.yml`

- Triggers: `schedule` (03:00 UTC) and `workflow_dispatch` with a scenario filter
  and matrix-subset input, so a failed subset can be re-run cheaply. Because it
  needs no secrets and no tunnel, a smoke subset can later also run on
  `pull_request` (path-filtered) and on forks.
- `concurrency: e2e-ha`, `cancel-in-progress: false`; `timeout-minutes: 90`;
  `runs-on: ubuntu-latest`.
- Steps:
  1. Install minikube and kubectl; build the slaude, mock-llm and fake-slack
     images inside minikube.
  2. `deploy/k8s-local/up.sh` with `ANTHROPIC_BASE_URL` set to the mock-LLM Service,
     a dummy key, and `SLAUDE_SLACK_API_URL` set to the fake-Slack Service; apply
     the `e2e/k8s` overlay.
  3. Register personas with `slack-app add` inside a gateway pod, using the
     generated credentials shared with the fake.
  4. Run `verify-ha.sh` then `verify-turns.sh` as cluster sanity.
  5. Run `bun test e2e/`: create channels and users in the fake, expand the matrix,
     drive cases through the control API, assert on the fake's call log, the
     mock-LLM journal and cluster state.
  6. Always: collect artifacts, tear down.
- Artifacts on failure: pod logs, mock-LLM journal, fake-Slack call log and thread
  transcripts. A pass/fail matrix goes in the job summary. A failing run opens or
  updates a single tracking issue.
- Secrets: none.
- No blind retries. A failing case is recorded with its evidence; the subset is
  re-run through `workflow_dispatch`.

### Real-Slack canary: `.github/workflows/e2e-slack-canary.yml`

- Triggers: `schedule` (daily, after the matrix) and `workflow_dispatch`.
- `concurrency: e2e-slack-canary`, `cancel-in-progress: false`; short timeout.
- Brings up the same cluster with one persona on the real workspace, starts
  `cloudflared` with the named-tunnel token, runs the three-step round trip
  (mention in a channel, threaded reply, DM), archives its test channel, tears
  down.
- Secrets: the persona's bot token and signing secret, the test user's token, the
  tunnel token. No model key. The repo is public: workspace and team identifiers
  live in secrets and variables, never in committed files.
- A canary failure opens its own labelled issue and never blocks the matrix. When
  the canary and the matrix disagree, the fake is wrong and gets fixed first.

## Risks

- **CLI vs mock fidelity.** The Claude CLI may call endpoints or send headers the
  mock does not expect. Mitigated by the spike; fallback is a thin custom mock.
- **Fake Slack drifts from real Slack.** The main cost of the fake. Mitigations:
  responses and slaude's requests are validated against vendored OpenAPI
  schemas; unknown methods fail loudly; the daily real-Slack canary samples the
  real wire; and a canary/matrix disagreement means the fake is fixed first. What
  only real Slack shows (Block Kit validation, mrkdwn rendering) is explicitly
  not claimed by the matrix.
- **The fake is more code to maintain.** About a few hundred lines with a bounded
  method list. The unknown-method failure turns "slaude started calling a new
  Slack method" into a one-line fake change instead of a silent gap.
- **One production-code change.** `SLAUDE_SLACK_API_URL` touches gateway Slack
  client construction. It is off by default and ships in an ordinary PR; it does
  not touch `install.sh`, the dist layout, the DB schema or the agent loop.
- **Slack outages and rate limits** now affect only the canary, which is
  reported separately.
- **Runner capacity.** minikube needs about 3.5 GB; `ubuntu-latest` on a public
  repo has headroom, but the matrix runtime must stay inside the 90-minute limit.
- **Killed-node lock TTL.** A killed node never releases its session lock, so a
  re-delivered turn waits out that lock's TTL (10 minutes; see the 2026-09-29 cron-claim and turn-failover field note).
  Kill-scenario timeouts must allow for it; this is a latency bound, not a bug.
- **Baseline test flake.** `cli/migrate-sqlite` ("main: --help, missing target, and
  a PGLite-dir run") failed once in a full `bun test` and passed on re-run. It is
  unrelated to this work, but it is a flaky test in the PR gate and worth fixing
  separately.
- **Fault-attempt counter and mock replicas.** Inherited from the mock-LLM
  section: multi-attempt model faults need a single mock replica or client-IP
  affinity. The cluster overlay must set this explicitly.

## Rollout

1. Spike; decide aimock or custom. (Done: aimock on Node.)
2. Mock server plus the baseline scenarios (`echo`, `multi-tool`, `long-stream`,
   `think`, faults), testable locally with no cluster. (Done: in review.)
3. `SLAUDE_SLACK_API_URL` seam, then the fake Slack server (Web API in memory,
   signed inbound sender, control API, spec guard), tested in-process against one
   gateway before any cluster exists.
4. Cluster harness: the `e2e/k8s` overlay, crash helpers, a test driver; one
   persona, the `echo` scenario, manual dispatch of `e2e-ha.yml`.
5. HA scenarios (node loss, gateway loss and leader failover, cross-replica
   state, model and Slack faults), then multi-persona.
6. Enable the schedule, add the tracking-issue reporter, then a path-filtered PR
   smoke subset.
7. Real-Slack canary: sandbox workspace, test app, named tunnel, then
   `e2e-slack-canary.yml`.

No release candidate is required: apart from the one off-by-default env var in the
gateway, the work is test and deploy tooling and does not touch `install.sh`, the
dist layout, the DB schema or the agent loop.
