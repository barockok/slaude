import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { __resetMasterKeyCache, encrypt } from "../../../src/db/crypto";
import { createHttpSlackTransport } from "../../../src/gateway/slack/http-transport";
import type { SlackAppRow } from "../../../src/db/slack-apps";

let prevKey: string | undefined;
let prevUrl: string | undefined;
const stops: Array<() => Promise<void> | void> = [];

beforeAll(() => {
  prevKey = process.env.SLAUDE_MASTER_KEY;
  prevUrl = process.env.SLAUDE_SLACK_API_URL;
  process.env.SLAUDE_MASTER_KEY = randomBytes(32).toString("base64");
  __resetMasterKeyCache();
});

afterAll(() => {
  if (prevKey === undefined) delete process.env.SLAUDE_MASTER_KEY;
  else process.env.SLAUDE_MASTER_KEY = prevKey;
  if (prevUrl === undefined) delete process.env.SLAUDE_SLACK_API_URL;
  else process.env.SLAUDE_SLACK_API_URL = prevUrl;
  __resetMasterKeyCache();
});

afterEach(async () => {
  while (stops.length) await stops.pop()!();
});

function row(): SlackAppRow {
  return {
    api_app_id: "A0SEAM",
    team_id: "T0SEAM",
    tenant_id: "default",
    persona_id: "default",
    bot_token: encrypt("bot-token-seam"),
    signing_secret: encrypt("signing-secret-seam"),
    bot_user_id: "U0BOT",
    created_at: 1,
    updated_at: 1,
  };
}

test("with SLAUDE_SLACK_API_URL set, the transport's default client calls that base URL", async () => {
  const seen: Array<{ path: string; auth: string | null }> = [];
  const stub = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization") });
      return Response.json({ ok: true, user_id: "U0BOT", team_id: "T0SEAM" });
    },
  });
  stops.push(() => stub.stop(true));
  process.env.SLAUDE_SLACK_API_URL = `http://127.0.0.1:${stub.port}/api`;

  const t = createHttpSlackTransport({ port: 0, loadApps: async () => [row()], log: () => {} });
  await t.start();
  stops.push(() => t.stop());

  const res = await t.client.auth.test();
  expect(res.ok).toBe(true);
  expect(seen).toEqual([{ path: "/api/auth.test", auth: "Bearer bot-token-seam" }]);
});
