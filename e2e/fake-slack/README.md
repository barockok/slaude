# fake-slack

A small stand-in for Slack, for slaude's end-to-end tests. It plays both sides of the
HTTP-mode integration: it is the Web API that a gateway calls out to, and it is the
sender of signed Events API and interactivity requests that a gateway receives. A test
drives it over a control API and reads back what slaude said.

## What it is, and is not

It is a gateway-facing fake. It lets a test prove how gateways, nodes and the queue
behave: a message is answered once, a redelivered event is deduped, a clicked approval
card resolves on whichever replica receives it, a 429 or a 5xx from Slack is survived.

It is not Slack. It does not validate Block Kit, render mrkdwn, enforce channel
membership rules or rate limits (other than faults a test injects), and it implements
only the Web API methods slaude calls. A green run says nothing about whether real
Slack would accept a payload. The real-Slack canary planned as a follow-up samples that.

## Run it standalone

    bun e2e/fake-slack/main.ts

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `FAKE_SLACK_PUBLIC_URL` | `http://127.0.0.1:<port>` | Where gateways reach the fake (used to build `response_url`) |
| `FAKE_SLACK_TEAM_ID` | the fake's built-in team id | Team id reported by `auth.test` and put in events |
| `FAKE_SLACK_RETRY_DELAYS` | `0,60000,300000` | Slack-faithful delivery retry schedule in ms; the cluster overlay sets short values |

`GET /healthz` answers `ok`. State is in memory: restarting the process forgets every app,
channel, message and call. In the cluster, do not restart the fake mid-suite.

## Point slaude at it

Set `SLAUDE_SLACK_API_URL=http://host:port/api/` on the gateway (trailing slash included),
register an app whose bot token the fake knows (`POST /__fake/apps`, then
`bun src/cli/slack-app.ts add ...` with the same credentials), and send events to the
gateway's `/slack/events` and `/slack/interactions`. Bearer tokens are matched to apps; an
unknown token gets `invalid_auth`.

## Control API

Everything under `/__fake/`. It is unauthenticated: expose it ClusterIP-only. Bodies are
JSON objects; a malformed one gets 400, unknown fields in `send` and `click` are rejected
with `invalid_arguments: <field>`. A typed client is `control-client.ts`.

| Route | Purpose |
|---|---|
| `POST users` `{id, name}` | Add a human user |
| `POST apps` `{apiAppId, name, botUserId?, botToken?, signingSecret?}` | Add a Slack app and its bot user; omitted credentials are generated fresh on every call, so pass them to keep an app stable |
| `GET apps` | List apps (includes credentials: never expose the fake outside the test network) |
| `POST channels` `{id, name, isIm?, members?}` | Add a channel or DM |
| `POST send` `{app, channel, user, text, target, threadTs?, mention?, eventId?, duplicate?, retryNum?, retryDelaysMs?, ackTimeoutMs?}` | Post a human message and deliver its signed event to `target` (a base URL; the path `/slack/events` is appended), retrying like Slack. A down or slow target blocks the request for the retry schedule, so pass short `retryDelaysMs` when it may be down. `duplicate` delivers the same envelope twice |
| `POST send` `{app, channel, user, redeliverTs, target, ...}` | Redeliver an existing message as another event; `text`, `threadTs` and `mention` are rejected, and `user` must be the stored author |
| `POST click` `{app, user, channel, messageTs, actionId, target, value?, retryDelaysMs?, ackTimeoutMs?}` | Deliver a signed `block_actions` payload for a button on a message; the `response_url` it carries points back at the fake and applies a gateway's update |
| `GET thread?channel=&threadTs=` | Messages in a thread |
| `GET messages?channel=` | Every message in a channel |
| `GET calls?method=&since=` | The call log: every Web API call, inbound delivery and `response_url` hit, with `seq`, status, redacted args and any `schemaViolations`; `since` filters on `seq` |
| `DELETE calls` | Clear the call log |
| `POST faults` `{method, status, times, retryAfterSec?}` | Make the next `times` calls to `method` (or `*`) fail with `status`; 429 answers `ratelimited` with a `retry-after` header |
| `DELETE faults` | Clear faults |
| `POST reset` | Clear the call log, faults and response URLs, and delete every message; apps, users and channels stay |

## Web API methods

Implemented: `auth.test`, `chat.postMessage`, `chat.update`, `chat.delete`,
`chat.postEphemeral`, `reactions.add`, `reactions.remove`, `users.info`,
`users.profile.set`, `conversations.replies`, `conversations.info`,
`conversations.members`, `conversations.setTopic`, `conversations.setPurpose`,
`search.messages`, `pins.add`, `pins.remove`, `files.info`, `assistant.threads.setStatus`.

Any other method fails loudly: the reply is `{ok: false, error: "unknown_method"}` and the
call is logged with `unknown: true`. The gateway test asserts that no logged call has that
flag, so a new Slack call in slaude shows up as a red test that asks for the method to be
added, not as a silent pass.

## Schema guard

Behind the option `strictSchemas`, the fake judges every Web API call against
`schemas/methods.json`: unknown parameters, missing required parameters and unknown
top-level response properties are recorded as `schemaViolations` on the call-log row. The
response sent to the caller is never changed. The in-process gateway test turns it on and
asserts no violations; the cluster fake does not run with it.

The vendored subset is derived from [slackapi/slack-api-specs](https://github.com/slackapi/slack-api-specs)
(file `web-api/slack_web_openapi_v2_without_examples.json`, commit
`bc08db49625630e3585bf2f1322128ea04f2a7f3`, MIT licence, Copyright (c) 2017 SlackAPI). It is
regenerated with `scripts/vendor-slack-schemas.ts`.

Limits, so a green result is read correctly:

- The guard is only as strong as the archived spec. Where the spec marks nothing required
  (`chat.delete`, for one), a dropped argument is not caught.
- Only top-level response properties are judged, not nested ones.
- `token` is always an allowed parameter and `ok` and `error` are always allowed response
  properties. A parameter sent as `null` counts as supplied.
- A method with no schema is not judged at all: `assistant.threads.setStatus` is absent from
  the archived spec, yet the gateway calls it. A schema flagged `responseUnjudged` skips only
  the response check, where the spec does not describe the response (`search.messages`).

## Tests

In-process fidelity test: the real `createGateway` on the real HTTP transport with the
simulation agent, against this fake, in one process. It needs no cluster, no Postgres and
no Redis.

    bun test e2e/fake-slack

Cluster suite (needs minikube; uses the mock LLM from `e2e/mock-llm` and no credentials):

    scripts/e2e-ha.sh                       # every e2e/ha/*.e2e.ts
    scripts/e2e-ha.sh ./e2e/ha/echo.e2e.ts  # one file (the leading ./ is required)

See the header of `scripts/e2e-ha.sh` for the guards, `E2E_*` switches and the diagnostics
it collects on failure. The workflow `.github/workflows/e2e-ha.yml` runs the same script on a
runner, dispatched by hand.

The follow-up HA scenarios (node kill, gateway kill, cross-replica approvals, model and
Slack faults, multi-persona) and the real-Slack canary are not in this suite yet. The
multi-persona identity check needs a gateway defect fixed first: calls made through the HTTP
transport's shared client (what the agent's surface and tools use when a persona has no user
token of its own) go out as the oldest registered app (see the field note; pointers:
`src/gateway/slack/http-transport.ts` and `src/gateway/core/gateway.ts`).
