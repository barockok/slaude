import { describe, expect, test } from "bun:test";
import { emitDomainEvents } from "../../src/audit/domain";
import type { DomainEvent } from "../../src/db/domain";

const events: DomainEvent[] = [
  { action: "user.created", userId: "u1" },
  { action: "binding.created", userId: "u1", bindingId: "b1", service: "slack", state: "observed" },
  { action: "boundary.created", boundaryId: "c1", service: "slack", state: "declared" },
  { action: "user.adopted", userId: "u2", fromUserId: "u1", bindingIds: ["b1", "b2"] },
];

function collect(opts: Parameters<typeof emitDomainEvents>[1] = {}) {
  const got: { action: string; details: Record<string, unknown>; summary: string }[] = [];
  const p = emitDomainEvents(events, opts, {
    sink: () => {},
    insert: async (ev) => {
      got.push({ action: ev.action, details: ev.details, summary: ev.summary });
    },
  });
  return p.then(() => got);
}

describe("emitDomainEvents", () => {
  test("writes one audit event per domain event", async () => {
    const got = await collect({ actorId: "system" });
    expect(got.map((g) => g.action)).toEqual(["user.created", "binding.created", "boundary.created", "user.adopted"]);
  });
  test("details carry ids only, never a binding value", async () => {
    const got = await collect();
    const text = JSON.stringify(got);
    expect(text).not.toContain("@");
    expect(got[1]!.details).toMatchObject({ binding_id: "b1", user_id: "u1", service: "slack", state: "observed" });
    expect(got[3]!.details).toMatchObject({ from_user_id: "u1", binding_ids: ["b1", "b2"] });
  });
  test("suppress writes nothing", async () => {
    expect(await collect({ suppress: true })).toEqual([]);
  });
});
