/** The per-turn block under memory places (rc.47): each section has its own slice of the deadline and a late one is dropped alone. */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { buildTurnMemoryContext, SECTION_SLICE } from "../../src/memory/turn-context";
import { composePage } from "../../src/knowledge/memory-pages";
import { PUBLIC_SOURCE, SHARED_SOURCE, agentSourceId, profileSourceId, type BrainScope } from "../../src/knowledge/scope";
import { placeSourceId } from "../../src/memory/place";
import { fakeBrain } from "./fake-brain";

const AGENT = agentSourceId("U_SLAUDE");
const PROFILE = profileSourceId("T", "U0ALICE");
const PLACE = placeSourceId("U_SLAUDE", "b1");
const THREAD = "C0TEAM:100.1";
const scope: BrainScope = { clientId: "U_SLAUDE", sourceId: PLACE, allowedSources: [PLACE, AGENT, "agent", SHARED_SOURCE, PUBLIC_SOURCE, PROFILE], profileSource: PROFILE, placeAgent: "U_SLAUDE" };

async function put(fb: ReturnType<typeof fakeBrain>, source: string, slug: string, content: string, typed?: { type: string; fields?: Record<string, string> }) {
  let text = content;
  if (typed) {
    const r = composePage({ slug, content, type: typed.type, ...(typed.fields ? { fields: typed.fields } : {}) }, new Date("2026-10-01T12:00:00Z"));
    if ("error" in r) throw new Error(r.error);
    text = r.content;
  }
  await fb.call("put_page", { slug, content: text }, { clientId: "x", sourceId: source, allowedSources: [source] });
}
async function seeded() {
  const fb = fakeBrain();
  await put(fb, PROFILE, "profile", "Prefers short answers.", { type: "profile" });
  await put(fb, AGENT, "self/lessons", "- 2026-10-01 Be brief.", { type: "lessons" });
  await put(fb, PLACE, "commitments/c1", "ship the fix", { type: "commitment", fields: { promiser: "U_SLAUDE", beneficiary: "U0ALICE", thread: THREAD, status: "open" } });
  await put(fb, SHARED_SOURCE, "shared/channels/c0team", "Team notes here.");
  return fb;
}
const build = (fb: ReturnType<typeof fakeBrain>, call: (n: string, p: Record<string, unknown>, s: BrainScope) => Promise<unknown>, over = {}) =>
  buildTurnMemoryContext({ call, scope, agentSource: AGENT, speaker: "U0ALICE", threadKey: THREAD, channelId: "C0TEAM", now: () => new Date("2026-10-25T12:00:00Z"), ...over });

let warn: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
  warn?.mockRestore();
  warn = null;
});

describe("sliced block (placesOn)", () => {
  test("everything answers in time: the same four sections as the whole-block build", async () => {
    const fb = await seeded();
    const sliced = (await build(fb, fb.call, { placesOn: true, timeoutMs: 2000 }))!;
    const whole = (await build(fb, fb.call, { placesOn: false, timeoutMs: 2000 }))!;
    expect(sliced).toBe(whole);
    for (const t of ["<profile>", "<lessons>", "<open-commitments>", "<channel-notes>"]) expect(sliced).toContain(t);
  });

  test("a slow commitment scan drops only the commitments; profile, lessons and notes stay", async () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    const fb = await seeded();
    const call = async (n: string, p: Record<string, unknown>, s: BrainScope) => {
      if (n === "list_pages" && p.type === "commitment") return new Promise(() => {});
      return fb.call(n, p, s);
    };
    const t0 = Date.now();
    const out = (await build(fb, call, { placesOn: true, timeoutMs: 100 }))!;
    expect(out).toContain("<profile>");
    expect(out).toContain("<lessons>");
    expect(out).toContain("<channel-notes>");
    expect(out).not.toContain("<open-commitments>");
    expect(Date.now() - t0).toBeLessThan(600);
    expect(warn!.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toContain("open-commitments skipped");
  });

  test("a slow lessons read drops only the lessons", async () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    const fb = await seeded();
    const call = async (n: string, p: Record<string, unknown>, s: BrainScope) => {
      if (n === "get_page" && p.slug === "self/lessons") return new Promise(() => {});
      return fb.call(n, p, s);
    };
    const out = (await build(fb, call, { placesOn: true, timeoutMs: 100 }))!;
    expect(out).toContain("<profile>");
    expect(out).toContain("<open-commitments>");
    expect(out).not.toContain("<lessons>");
  });

  test("a section that throws is dropped alone, and the warning carries no page text", async () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    const fb = await seeded();
    const call = async (n: string, p: Record<string, unknown>, s: BrainScope) => {
      if (n === "list_pages" && p.type === "commitment") throw new Error("boom Prefers short answers.");
      return fb.call(n, p, s);
    };
    const out = (await build(fb, call, { placesOn: true }))!;
    expect(out).toContain("<profile>");
    expect(out).not.toContain("<open-commitments>");
    expect(warn!.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).not.toContain("short answers");
  });

  test("every section late gives no block", async () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    const out = await buildTurnMemoryContext({ call: () => new Promise(() => {}), scope, agentSource: AGENT, speaker: "U0ALICE", threadKey: THREAD, channelId: "C0TEAM", placesOn: true, timeoutMs: 30 });
    expect(out).toBeNull();
  });

  test("slices are fractions of the deadline", () => {
    for (const v of Object.values(SECTION_SLICE)) expect(v).toBeGreaterThan(0);
    for (const v of Object.values(SECTION_SLICE)) expect(v).toBeLessThanOrEqual(1);
  });
});

describe("without placesOn one late read still drops the whole block (unchanged)", () => {
  test("absent and false", async () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    const fb = await seeded();
    const call = async (n: string, p: Record<string, unknown>, s: BrainScope) => {
      if (n === "list_pages" && p.type === "commitment") return new Promise(() => {});
      return fb.call(n, p, s);
    };
    expect(await build(fb, call, { timeoutMs: 50 })).toBeNull();
    expect(await build(fb, call, { placesOn: false, timeoutMs: 50 })).toBeNull();
  });
});
