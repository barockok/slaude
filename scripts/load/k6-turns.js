/**
 * k6 load: 200 concurrent threads through the REAL HTTP ingress (spec §8).
 *
 * Drives signed Slack Events API envelopes at a running gateway (e.g. the
 * docker-compose.scale.yaml stack), one DM thread per VU. Each iteration is
 * one inbound message; the gateway verifies the signature, dedups, creates
 * the session and enqueues the turn onto BullMQ for the node workers.
 *
 * Prereqs: an app registered with a signing secret you know —
 *   bun run slack-app add --api-app-id A0LOAD --team-id T0LOAD \
 *     --bot-token xoxb-load --signing-secret load-secret
 *
 * Run (defaults match that registration):
 *   k6 run scripts/load/k6-turns.js \
 *     -e GATEWAY_URL=http://localhost:8080 -e SIGNING_SECRET=load-secret \
 *     -e APP_ID=A0LOAD -e TEAM_ID=T0LOAD
 *
 * Thresholds gate the HTTP ack path (the gateway must accept fast even under
 * fan-out). Queue claim latency is a node-side measurement — scrape
 * slaude_node_claim_latency from the nodes' :8081/metrics while this runs,
 * or use the in-process variant (scripts/load/claim-latency.ts) which samples
 * the full claim-latency distribution directly and enforces p95 < 500ms.
 */
import http from "k6/http";
import { check } from "k6";
import crypto from "k6/crypto";

const GATEWAY_URL = __ENV.GATEWAY_URL || "http://localhost:8080";
const SIGNING_SECRET = __ENV.SIGNING_SECRET || "load-secret";
const APP_ID = __ENV.APP_ID || "A0LOAD";
const TEAM_ID = __ENV.TEAM_ID || "T0LOAD";

export const options = {
  scenarios: {
    turns: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || 200), // one DM thread per VU
      duration: __ENV.DURATION || "60s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    // Slack requires an ack within 3s; hold the ingress far under that.
    http_req_duration: ["p(95)<500"],
  },
};

export default function () {
  const now = Math.floor(Date.now() / 1000);
  const threadTs = `9${String(__VU).padStart(4, "0")}.0`;
  const ts = `9${String(__VU).padStart(4, "0")}.${__ITER + 1}`;
  const body = JSON.stringify({
    type: "event_callback",
    api_app_id: APP_ID,
    team_id: TEAM_ID,
    event: {
      type: "message",
      channel: `D0K6${__VU}`,
      channel_type: "im",
      user: "U0MGR",
      text: `k6 turn ${__ITER}`,
      ts,
      thread_ts: threadTs,
      team: TEAM_ID,
    },
  });
  const sig = "v0=" + crypto.hmac("sha256", SIGNING_SECRET, `v0:${now}:${body}`, "hex");
  const res = http.post(`${GATEWAY_URL}/slack/events`, body, {
    headers: {
      "Content-Type": "application/json",
      "X-Slack-Request-Timestamp": String(now),
      "X-Slack-Signature": sig,
    },
  });
  check(res, { "acked 2xx": (r) => r.status >= 200 && r.status < 300 });
}
