import { describe, expect, test } from "bun:test";
import { createPlaceResolver, isPlaceSourceId, NO_PLACE_REASONS, placeSourceId, type PlaceDeps } from "../../src/memory/place";

const mk = (d: PlaceDeps = {}) =>
  createPlaceResolver({
    role: () => "mono",
    timeoutMs: () => 50,
    sessionBoundary: async () => null,
    jobBoundary: async () => null,
    channelBoundary: async () => null,
    channelLookupFailed: () => false,
    kindOf: async () => "channel",
    ...d,
  });
const base = { agentId: "agent1", teamId: "T1", channel: "C1" };

describe("placeSourceId", () => {
  test("is mb- plus 28 hex characters, 31 in all", () => {
    const s = placeSourceId("agent1", "b1");
    expect(s).toMatch(/^mb-[0-9a-f]{28}$/);
    expect(s.length).toBe(31);
    expect(isPlaceSourceId(s)).toBe(true);
    expect(isPlaceSourceId("mb-xyz")).toBe(false);
  });
  test("agent and boundary are separated by a NUL, so a shifted split cannot collide", () => {
    expect(placeSourceId("ab", "c")).not.toBe(placeSourceId("a", "bc"));
  });
});

describe("placeFor", () => {
  test("a node has no database", async () => {
    expect(await mk({ role: () => "node" })({ ...base })).toEqual({ kind: "none", reason: "node-no-db" });
  });
  test("no team", async () => {
    expect(await mk()({ ...base, teamId: null })).toEqual({ kind: "none", reason: "no-team" });
  });
  test("a channel that is not a Slack channel id is an unknown surface", async () => {
    expect(await mk()({ ...base, channel: "cron:abc" })).toEqual({ kind: "none", reason: "unknown-surface" });
    expect(await mk()({ ...base, channel: undefined })).toEqual({ kind: "none", reason: "unknown-surface" });
  });
  test("no boundary row yet", async () => {
    expect(await mk()({ ...base })).toEqual({ kind: "none", reason: "no-boundary" });
  });
  test("a failed read is lookup-failed, not no-boundary", async () => {
    expect(await mk({ channelLookupFailed: () => true })({ ...base })).toEqual({ kind: "none", reason: "lookup-failed" });
  });
  test("the channel resolver answers a place", async () => {
    const r = await mk({ channelBoundary: async () => "b1", kindOf: async () => "dm" })({ ...base });
    expect(r).toEqual({ kind: "place", source: placeSourceId("agent1", "b1"), boundaryId: "b1", boundaryKind: "dm" });
  });
  test("the session row wins over the resolver", async () => {
    let asked = false;
    const r = await mk({ sessionBoundary: async () => "bs", channelBoundary: async () => { asked = true; return "bc"; } })({ ...base, sessionId: "s1" });
    expect(r.kind === "place" && r.boundaryId).toBe("bs");
    expect(asked).toBe(false);
  });
  test("the job row is read when the session row has none, and works without a team", async () => {
    const r = await mk({ jobBoundary: async (id) => (id === "j1" ? "bj" : null) })({ agentId: "agent1", teamId: null, channel: null, cronJobId: "j1" });
    expect(r.kind === "place" && r.boundaryId).toBe("bj");
  });
  test("a slow read gives lookup-failed within the bound", async () => {
    const t0 = Date.now();
    const r = await mk({ channelBoundary: () => new Promise(() => {}) })({ ...base });
    expect(r).toEqual({ kind: "none", reason: "lookup-failed" });
    expect(Date.now() - t0).toBeLessThan(500);
  });
  test("a throwing read gives lookup-failed, never an exception", async () => {
    const r = await mk({ sessionBoundary: async () => { throw new Error("boom"); } })({ ...base, sessionId: "s1" });
    expect(r).toEqual({ kind: "none", reason: "lookup-failed" });
  });
  test("an unknown boundary kind row is lookup-failed", async () => {
    expect(await mk({ channelBoundary: async () => "b1", kindOf: async () => null })({ ...base })).toEqual({ kind: "none", reason: "lookup-failed" });
  });
  test("every reason is one of the documented set", () => {
    expect([...NO_PLACE_REASONS].sort()).toEqual(["lookup-failed", "no-boundary", "no-team", "node-no-db", "unknown-surface"]);
  });
});
