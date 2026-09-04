---
title: Webhook (Events API) mode
description: Run Slack ingress over HTTP instead of Socket Mode — one app per workspace, registered in Postgres, verified by signature.
---

# Webhook (Events API) mode

The [Getting started](../start/getting-started.md) guide runs Slack over **Socket
Mode**: slaude opens an outbound WebSocket to Slack and no inbound port is
needed. That is the default (`SLAUDE_SLACK_MODE=socket`) and the right choice
for most single-workspace deploys.

**Webhook mode** (`SLAUDE_SLACK_MODE=http`) flips that: Slack POSTs signed
requests to your gateway's `/slack/events` and `/slack/interactions`. Reach
for it when:

- your network blocks long-lived outbound WebSockets but allows inbound HTTPS
  behind a load balancer,
- you're running the [horizontal-scale topology](multi-node.md) — gateway
  replicas need a shared ingress, not one Socket Mode connection per replica,
- you want to install the same app into more than one workspace without
  hand-editing tokens per deploy.

Unlike Socket Mode, webhook mode does not read `SLACK_BOT_TOKEN` /
`SLACK_APP_TOKEN` at all. Apps live in an encrypted Postgres registry
(`slack_apps`), resolved per request by `(api_app_id, team_id)`, so it works
the same way whether you're running one workspace or twenty.

## Prerequisites

- `SLAUDE_DB=pg` — the registry lives in Postgres; sqlite cannot hold it.
- `SLAUDE_MASTER_KEY` — encrypts each app's bot token and signing secret at
  rest (AES-256-GCM). Generate one with `openssl rand -base64 32` and treat it
  like any other production secret — losing it makes every registered app
  unusable.
- A public HTTPS URL for your gateway (Slack will not deliver events to plain
  HTTP or to `localhost`).

## 1. Register the app

Two ways to get an app into the registry — pick one.

**Manual — you already have a bot token and signing secret** (from
**api.slack.com/apps** → your app → **Basic Information** /
**OAuth & Permissions**):

```sh
SLAUDE_DB=pg SLAUDE_MASTER_KEY=... \
  bun run slack-app add \
    --api-app-id A0123456 --team-id T0123456 \
    --bot-token xoxb-... --signing-secret ... \
    --tenant default --persona default
```

`--bot-token` and `--signing-secret` fall back to `SLACK_BOT_TOKEN` /
`SLACK_SIGNING_SECRET` in the environment, so an existing `.env` can be
imported without pasting secrets on the command line. `bun run slack-app list`
shows what's registered (tokens masked); `bun run slack-app remove` retires an
app.

**OAuth install flow — installing into workspaces you don't control ahead of
time.** Set `SLACK_CLIENT_ID` + `SLACK_CLIENT_SECRET` (from your app's
**Basic Information** page) and the gateway serves `GET /slack/oauth/start` →
redirects to Slack's authorize screen → `GET /slack/oauth/callback` exchanges
the code and writes the `slack_apps` row itself. Point a workspace admin at
`https://<your-host>/slack/oauth/start` and installing the app registers it.
Both routes 404 when `SLACK_CLIENT_ID` is unset.

## 2. Point Slack at your gateway

Generate the app manifest for HTTP mode:

```sh
bun run manifest --mode http --url https://<your-host> > manifest.json
```

This emits `event_subscriptions.request_url` = `https://<your-host>/slack/events`
and `interactivity.request_url` = `https://<your-host>/slack/interactions`, and
omits `socket_mode_enabled`. If `SLACK_CLIENT_ID` is set in your environment
when you run this, it also fills in `oauth_config.redirect_urls` with the
`/slack/oauth/callback` URL (override with `SLACK_OAUTH_REDIRECT_URL` if the
callback host differs from `--url`).

If you're creating the app fresh: **api.slack.com/apps** → **Create New App**
→ **From manifest** → paste `manifest.json` → **Create**. If the app already
exists (you registered it manually in step 1), paste the same manifest into
**App Manifest** in its settings instead — Slack will show the diff for
Event Subscriptions / Interactivity request URLs and prompt you to save.

Slack will call your `request_url` with a `url_verification` challenge before
accepting it; the gateway answers that automatically once it's running (step
3).

## 3. Boot the gateway

```sh
SLAUDE_SLACK_MODE=http \
SLAUDE_DB=pg \
SLAUDE_MASTER_KEY=... \
SLAUDE_HTTP_PORT=8080 \
  bun src/server.ts
```

Look for `[slaude] slack http mode started` in the logs. This single port
serves `/slack/events`, `/slack/interactions`, `/healthz`, `/readyz`,
`/metrics`, and `/v1` — the standalone `SLAUDE_HEALTH_PORT` server does not
start in http mode.

Full variable reference, including `SLAUDE_HTTP_MAX_BODY_BYTES` and the
registry-vs-env token precedence: [Configuration → Slack —
optional](../reference/configuration.md#slack).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `SLAUDE_SLACK_MODE=http requires SLAUDE_DB=pg` at boot | sqlite can't hold the registry — set `SLAUDE_DB=pg`. |
| Slack shows the request URL as unverified | The gateway wasn't reachable at `--url` when Slack sent `url_verification`, or the URL in the manifest doesn't match where the gateway is actually listening. |
| `404` on every event | No `slack_apps` row matches the incoming `(api_app_id, team_id)` — check `bun run slack-app list`, or that the OAuth install actually completed. |
| Signature verification failing | The signing secret registered for that app doesn't match the one in your Slack app's **Basic Information** page — re-run `slack-app add` with the current secret, or reinstall via OAuth. |
