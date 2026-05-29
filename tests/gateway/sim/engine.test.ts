import { describe, it, expect, afterEach } from "bun:test";
import { SimSession } from "../../../src/gateway/sim/engine";

let s: SimSession | undefined;
afterEach(async () => { await s?.dispose(); s = undefined; });

describe("SimSession", () => {
  it("manager in a DM gets a reply", async () => {
    s = await SimSession.create({ preset: "manager-dm", agent: "stub" });
    await s.send({ text: "hello" });
    const replies = s.cards().filter((c) => c.kind === "message" && c.channel !== "(respond)" && (c.text ?? "").length > 0);
    expect(replies.length).toBeGreaterThan(0);
  });

  it("member in a trusted channel is admitted and replied to", async () => {
    s = await SimSession.create({ preset: "member-trusted", agent: "stub" });
    await s.send({ text: "status?" });
    expect(s.cards().some((c) => (c.text ?? "").includes("ack"))).toBe(true);
  });

  it("non-manager in an unlisted channel is dropped (whitelist)", async () => {
    s = await SimSession.create({ preset: "restricted-blocked", agent: "stub" });
    await s.send({ text: "hello" });
    expect(s.drops().some((d) => d.reason === "whitelist")).toBe(true);
    expect(s.cards().filter((c) => c.kind === "message" && c.channel !== "(respond)" && (c.text ?? "").length > 0).length).toBe(0);
  });

  it("approval flow: wrong approver leaves it pending, manager resolves", async () => {
    s = await SimSession.create({ preset: "approval-flow", agent: "stub" });
    await s.send({ text: "deploy prod" });
    expect(s.cards().some((c) => c.kind === "approval")).toBe(true);
    await s.click({ as: "U0BOB", action: "approve" });   // U0BOB not an approver -> stays pending
    expect(s.cards().find((c) => c.kind === "approval")!.resolved).toBe(false);
    // ApprovalGate authorizes only the explicit catchall approver (U0APP); the
    // manager is NOT auto-included in the approver set, so U0APP resolves it.
    await s.click({ as: "U0APP", action: "approve" });
    expect(s.cards().find((c) => c.kind === "approval")!.resolved).toBe(true);
  });
});
