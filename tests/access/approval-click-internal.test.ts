/**
 * Slice C task 21: approver and click paths on user ids. Under
 * SLAUDE_ACCESS_SOURCE=internal the card's allowlist names direct Slack ids and
 * the users that `email:` and `user:` entries name; a click from such a user is
 * decided at click time and needs their Slack binding VERIFIED, their email
 * still verified, and no deny. A click with no resolvable user is refused.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Grant } from "../../src/access/grants";
import { __setGrantsReader } from "../../src/access/role";
import { settleShadows } from "../../src/access/wired";
import * as Domain from "../../src/db/domain";
import * as PendingGates from "../../src/db/pending-gates";
import { db } from "../../src/db/schema";
import { ApprovalGate } from "../../src/gateway/slack/approval-gate";
import * as Actor from "../../src/refs/actor";
import { __resetDecide } from "../../src/access/decide";

const TEAM = "T0EXAMPLE";
const PERSONA = "scout";
const MAIL = "approver@example.com";
const g = (o: Partial<Grant> & Pick<Grant, "subjectKind" | "subjectId">): Grant => ({ role: "member", deny: false, dmOnly: false, source: "console", ...o });
const emailGrant = (address: string, role: Grant["role"], o: Partial<Grant> = {}) => g({ subjectKind: "user", subjectId: `email:${address}`, role, subject: { service: "email", address }, ...o });
const slackGrant = (id: string, role: Grant["role"], o: Partial<Grant> = {}) => g({ subjectKind: "user", subjectId: id, role, subject: { service: "slack" }, ...o });

let saved: string | undefined;
let grants: Grant[] = [];
beforeEach(async () => {
  saved = process.env.SLAUDE_ACCESS_SOURCE;
  process.env.SLAUDE_ACCESS_SOURCE = "internal";
  await Domain._wipeForTests();
  Actor.invalidateActors();
  __resetDecide();
  grants = [];
  __setGrantsReader(async () => grants);
  spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await settleShadows();
  __setGrantsReader(null);
  if (saved === undefined) delete process.env.SLAUDE_ACCESS_SOURCE;
  else process.env.SLAUDE_ACCESS_SOURCE = saved;
  mock.restore();
});

/** A person with a Slack binding in `state` and a verified email. */
async function person(slackId: string, state: "observed" | "verified", mail?: string) {
  const s = await Domain.ensureBinding({ service: "slack", kind: "user", workspace: TEAM, value: slackId, state, source: "test" });
  if (mail) await Domain.ensureBinding({ service: "email", kind: "address", workspace: "", value: mail, state: "verified", source: "test", userId: s.userId });
  return s;
}

function harness() {
  const handlers: { m: RegExp; fn: any }[] = [];
  const posts: any[] = [];
  const dms: any[] = [];
  const app: any = {
    action: (m: RegExp, fn: any) => handlers.push({ m, fn }),
    client: { chat: { postMessage: async (x: any) => (x.channel?.startsWith("U") ? dms.push(x) : posts.push(x), { ok: true, ts: "1.1" }), update: async () => ({ ok: true }) } },
  };
  const gate = new ApprovalGate(app, [], { gateBus: null, timeoutSeconds: () => 0 });
  const click = async (id: string, user: string, team: string | null = TEAM) => {
    const responses: any[] = [];
    for (const h of handlers) {
      if (h.m.test(`slaude_appr:approve:${id}`)) await h.fn({ ack: async () => {}, action: { action_id: `slaude_appr:approve:${id}` }, body: { user: { id: user }, ...(team ? { team: { id: team } } : {}) }, respond: async (r: any) => void responses.push(r) });
    }
    return responses;
  };
  const open = async (persona = PERSONA) => (await gate.open({ channel: "C0EXAMPLE", threadTs: "1.1", summary: "ship it", sessionId: `S-${Math.random()}`, persona, app: { teamId: TEAM } })).pendingId;
  return { gate, click, open, posts, dms };
}
const status = async (id: string) => (await PendingGates.get(id))?.status;

describe("an approver by email", () => {
  beforeEach(() => {
    grants = [emailGrant(MAIL, "approver")];
  });

  test("with a verified Slack binding and a verified email can click", async () => {
    await person("U0APPROVER", "verified", MAIL);
    const h = harness();
    const id = await h.open();
    await h.click(id, "U0APPROVER");
    expect(await status(id)).toBe("approved");
  });

  test("with an observed Slack binding cannot, and the row stays pending", async () => {
    await person("U0APPROVER", "observed", MAIL);
    const h = harness();
    const id = await h.open();
    await h.click(id, "U0APPROVER");
    expect(await status(id)).toBe("pending");
  });

  test("with a verified Slack binding but no verified email cannot", async () => {
    await person("U0APPROVER", "verified");
    const h = harness();
    const id = await h.open();
    await h.click(id, "U0APPROVER");
    expect(await status(id)).toBe("pending");
  });

  test("a click with no resolvable user is refused", async () => {
    await person("U0APPROVER", "verified", MAIL);
    const h = harness();
    const id = await h.open();
    await h.click(id, "U0STRANGER");
    expect(await status(id)).toBe("pending");
  });

  test("a click that names no workspace is refused", async () => {
    await person("U0APPROVER", "verified", MAIL);
    const h = harness();
    const id = await h.open();
    await h.click(id, "U0APPROVER", null);
    expect(await status(id)).toBe("pending");
  });

  test("unlinking after the card was posted refuses the click at once", async () => {
    const p = await person("U0APPROVER", "verified", MAIL);
    const h = harness();
    const id = await h.open();
    await db.run("UPDATE bindings SET state = 'observed' WHERE id = ?", [p.binding.id]);
    await h.click(id, "U0APPROVER");
    expect(await status(id)).toBe("pending");
  });

  test("the card names the approver's verified Slack account, not an observed one", async () => {
    const p = await person("U0APPROVER", "verified", MAIL);
    await Domain.ensureBinding({ service: "slack", kind: "user", workspace: TEAM, value: "U0SECOND", state: "observed", source: "test", userId: p.userId });
    const h = harness();
    await h.open();
    const text = JSON.stringify(h.posts[0].blocks);
    expect(text).toContain("<@U0APPROVER>");
    expect(text).not.toContain("U0SECOND");
    expect(text).not.toContain(MAIL);
  });

  test("a card whose only approver has no verified Slack account says so and admits nobody else", async () => {
    await person("U0APPROVER", "observed", MAIL);
    const h = harness();
    const id = await h.open();
    expect(JSON.stringify(h.posts[0].blocks)).toContain("no approver has a verified Slack account yet");
    await h.click(id, "U0STRANGER");
    expect(await status(id)).toBe("pending");
  });
});

describe("a denied clicker is refused whatever list names them", () => {
  test("a Slack deny beats a Slack approver entry", async () => {
    grants = [slackGrant("U0DENIED", "approver"), slackGrant("U0DENIED", "member", { deny: true })];
    await person("U0DENIED", "verified");
    const h = harness();
    const id = await h.open();
    await h.click(id, "U0DENIED");
    expect(await status(id)).toBe("pending");
  });

  test("a deny by email beats an email approver entry", async () => {
    grants = [emailGrant(MAIL, "approver"), emailGrant(MAIL, "member", { deny: true })];
    await person("U0APPROVER", "verified", MAIL);
    const h = harness();
    const id = await h.open();
    await h.click(id, "U0APPROVER");
    expect(await status(id)).toBe("pending");
  });

  test("a deny by email reaches an approver listed by Slack id too", async () => {
    grants = [slackGrant("U0APPROVER", "approver"), emailGrant(MAIL, "member", { deny: true })];
    await person("U0APPROVER", "verified", MAIL);
    const h = harness();
    const id = await h.open();
    await h.click(id, "U0APPROVER");
    expect(await status(id)).toBe("pending");
  });
});

describe("a direct Slack approver keeps today's click", () => {
  test("an approver listed by Slack id can click even before the resolver has seen them", async () => {
    grants = [slackGrant("U0DIRECT", "approver")];
    const h = harness();
    const id = await h.open();
    await h.click(id, "U0DIRECT");
    expect(await status(id)).toBe("approved");
  });

  test("a stranger is refused", async () => {
    grants = [slackGrant("U0DIRECT", "approver")];
    const h = harness();
    const id = await h.open();
    await h.click(id, "U0STRANGER");
    expect(await status(id)).toBe("pending");
  });

  test("SLAUDE_PRIVILEGED_NEEDS_VERIFIED asks for the verified Slack binding of a direct approver too", async () => {
    process.env.SLAUDE_PRIVILEGED_NEEDS_VERIFIED = "1";
    try {
      grants = [slackGrant("U0DIRECT", "approver")];
      await person("U0DIRECT", "observed");
      const h = harness();
      const id = await h.open();
      await h.click(id, "U0DIRECT");
      expect(await status(id)).toBe("pending");
    } finally {
      delete process.env.SLAUDE_PRIVILEGED_NEEDS_VERIFIED;
    }
  });

  test("a resolver outage refuses the click of a listed approver (privileged: never from legacy)", async () => {
    grants = [slackGrant("U0DIRECT", "approver")];
    const h = harness();
    const id = await h.open();
    spyOn(Domain, "findBinding").mockRejectedValue(new Error("db down"));
    await h.click(id, "U0DIRECT");
    mock.restore();
    expect(await status(id)).toBe("pending");
  });

  test("an old card with no user list behaves as before", async () => {
    grants = [];
    const id = `old-${Math.random()}`;
    await PendingGates.create({ id, kind: "approval", sessionId: "S-old", payload: { channel: "C0EXAMPLE", threadTs: "1.1", summary: "x", category: null, approvers: ["U0OLD"], waiter: "poll", personaName: PERSONA } });
    const h = harness();
    await h.click(id, "U0NEW");
    expect(await status(id)).toBe("pending");
    await h.click(id, "U0OLD");
    expect(await status(id)).toBe("approved");
  });
});

describe("under shadow nothing changes", () => {
  test("an email approver cannot click, and the card carries no user list", async () => {
    process.env.SLAUDE_ACCESS_SOURCE = "shadow";
    grants = [emailGrant(MAIL, "approver"), slackGrant("U0DIRECT", "approver")];
    await person("U0APPROVER", "verified", MAIL);
    const h = harness();
    const id = await h.open();
    expect((await PendingGates.get(id))?.payload.approverUsers).toBeUndefined();
    await h.click(id, "U0APPROVER");
    expect(await status(id)).toBe("pending");
    await h.click(id, "U0DIRECT");
    expect(await status(id)).toBe("approved");
  });
});
