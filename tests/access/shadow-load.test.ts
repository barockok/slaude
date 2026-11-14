/**
 * Slice C review: the shadow must not turn into load. Resolved grant subjects
 * are shared for a few seconds, one shadow resolves a bounded number of them,
 * at most MAX_INFLIGHT shadows run at once, and the actor cache is bounded.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { MAX_LOOKUPS_PER_CALL } from "../../src/access/decide";
import type { Grant } from "../../src/access/grants";
import { MAX_INFLIGHT, admitAt, settleShadows } from "../../src/access/wired";
import * as Domain from "../../src/db/domain";
import * as Actor from "../../src/refs/actor";
import { brainHandlers, type BrainToolDeps } from "../../src/knowledge/mcp-tools";
import { agentSourceId, resolveBrainScope } from "../../src/knowledge/scope";
import { fakeBrain } from "../memory/fake-brain";
import { count, decisions, useShadowEnv } from "../helpers/shadow-modes";

const TEAM = "T0EXAMPLE";
useShadowEnv();
const member = (id: string): Grant => ({ subjectKind: "user", subjectId: id, role: "member", deny: false, dmOnly: false, source: "console", subject: { service: "slack" } });
const people = (n: number) => Array.from({ length: n }, (_, i) => `U0P${String(i).padStart(4, "0")}`);
const seen = () => Domain.ensureBinding({ service: "slack", kind: "user", workspace: TEAM, value: "U0EXAMPLE", state: "observed", source: "test" });
const admit = (grants: Grant[], user = "U0EXAMPLE") => admitAt({ site: "gateway.admit", persona: "scout", teamId: TEAM, userId: user, channelId: "D0DM", isDM: true, grants });

describe("shadow load", () => {
  test("resolved subjects are shared between shadows: the second admit reads no binding", async () => {
    await seen();
    const grants = people(12).map(member);
    const find = spyOn(Domain, "findBinding");
    admit(grants);
    await settleShadows();
    const first = find.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    admit(grants);
    await settleShadows();
    // Only the acting user's own read (cached by the actor cache too) may remain; the 12 subjects are served from the share.
    expect(find.mock.calls.length - first).toBeLessThanOrEqual(1);
  });

  test("a link or unlink drops the shared lookups", async () => {
    await seen();
    const grants = people(5).map(member);
    const find = spyOn(Domain, "findBinding");
    admit(grants);
    await settleShadows();
    const first = find.mock.calls.length;
    Actor.invalidateActors();
    admit(grants);
    await settleShadows();
    expect(find.mock.calls.length - first).toBeGreaterThanOrEqual(5);
  });

  test("a persona with too many subjects is dropped, not resolved without bound", async () => {
    await seen();
    const find = spyOn(Domain, "findBinding");
    admit(people(MAX_LOOKUPS_PER_CALL + 20).map(member));
    await settleShadows();
    expect(count("slaude_access_shadow_total", { site: "gateway.admit", outcome: "dropped" })).toBe(1);
    expect(find.mock.calls.length).toBeLessThanOrEqual(MAX_LOOKUPS_PER_CALL + 1);
  });

  test("the concurrency gate is 16", () => {
    expect(MAX_INFLIGHT).toBe(16);
  });

  test("the actor cache stays under its bound", async () => {
    Actor.__setActorCacheMax(5);
    try {
      for (let i = 0; i < 12; i++) {
        await Domain.ensureBinding({ service: "slack", kind: "user", workspace: TEAM, value: `U0C${i}EXAMPLE`, state: "observed", source: "test" });
        await Actor.actingUser(TEAM, `U0C${i}EXAMPLE`);
      }
      expect(Actor.actorCacheSize()).toBeLessThanOrEqual(5);
    } finally {
      Actor.__setActorCacheMax(5_000);
    }
  });

  test("memory_about sends at most 3 subject compares per listing to the shadow", async () => {
    const brain = fakeBrain();
    const agent = "U0AGENT";
    process.env.SLAUDE_AGENT_ID ??= agent;
    const src = agentSourceId(agent);
    for (let i = 0; i < 8; i++) {
      await brain.call("put_page", { slug: `people/n${i}`, content: "---\ntype: person-note\nas_of: 2026-10-20\nconfidence: told\nsubject: U0ONE\n---\nnote" }, { clientId: "s", sourceId: src, allowedSources: [src] });
    }
    const sender = { userId: "U0ONE", teamId: TEAM, origin: "slack" as const };
    const g = { userId: "U0ONE", teamId: TEAM, interactive: true, origin: "slack" as const, lockedUser: null, channelTrust: "trusted" as const, isManager: false, agentId: agent, threadKey: "C0EXAMPLE:1.1", turnSenders: [sender] };
    const deps: BrainToolDeps = { scope: () => resolveBrainScope({ ...g, kbSources: [] }), gate: () => g, managers: () => [], requestApproval: async () => ({ approved: true, by: "U0ONE" }), call: (n, p, s) => brain.call(n, p, s) };
    const r = await brainHandlers.memory_about({ userId: "U0ONE" }, deps);
    expect(r.isError).toBeUndefined();
    await settleShadows();
    expect(decisions("kb_tools.memory_about_subject")).toBeGreaterThan(0);
    expect(decisions("kb_tools.memory_about_subject")).toBeLessThanOrEqual(3);
  });
});
