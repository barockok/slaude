// Console memory browsing against a real (PGLite) brain: stores with page
// counts, a store's pages by slug with an offset, one page with tags and links,
// and each read confined to the one store it names.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainCall, closeBrain, ensureSources, getBrain } from "../../src/knowledge/brain";
import { resetBackend } from "../../src/knowledge/backend";
import { localMemoryBrowser, memoryUnavailableReason, storeLabel } from "../../src/knowledge/memory-browse";
import { storeKind, type BrainScope } from "../../src/knowledge/scope";
import { seedBrainHome } from "../helpers/brain-template";

const home = mkdtempSync(join(tmpdir(), "memory-browse-"));
const saved = { home: process.env.SLAUDE_BRAIN_HOME, mode: process.env.SLAUDE_BRAIN_MODE, off: process.env.SLAUDE_BRAIN_DISABLED };
const shared: BrainScope = { clientId: "t", sourceId: "shared", allowedSources: ["shared"] };
const alice: BrainScope = { clientId: "UALICE", sourceId: "user-ualice", allowedSources: ["user-ualice"] };

beforeAll(async () => {
  await closeBrain();
  resetBackend();
  delete process.env.SLAUDE_BRAIN_MODE;
  delete process.env.SLAUDE_BRAIN_DISABLED;
  // A copy of the per-process template brain, not a fresh initdb (tests/helpers/brain-template.ts).
  await seedBrainHome(home);
  process.env.SLAUDE_BRAIN_HOME = home;
  await getBrain();
  await ensureSources(["user-ualice"]);
  await brainCall("put_page", { slug: "notes/b", content: "---\ntype: note\ntags: [ops]\n---\nSee [A](notes/a) for more." }, shared);
  await brainCall("put_page", { slug: "notes/a", content: "---\ntype: note\n---\nFirst page." }, shared);
  await brainCall("put_page", { slug: "notes/c", content: "Third page." }, shared);
  await brainCall("put_page", { slug: "notes/secret", content: "Alice only." }, alice);
  await brainCall("add_link", { from: "notes/b", to: "notes/a", link_type: "see_also", context: "for more" }, shared);
}, 120_000);

afterAll(async () => {
  await closeBrain();
  resetBackend();
  for (const [k, v] of [["SLAUDE_BRAIN_HOME", saved.home], ["SLAUDE_BRAIN_MODE", saved.mode], ["SLAUDE_BRAIN_DISABLED", saved.off]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("localMemoryBrowser", () => {
  const b = localMemoryBrowser();

  test("stores carry their kind and page count", async () => {
    const stores = await b.stores();
    expect(stores.find((s) => s.id === "shared")).toEqual({ id: "shared", kind: "shared", pageCount: 3 });
    expect(stores.find((s) => s.id === "user-ualice")).toEqual({ id: "user-ualice", kind: "personal", pageCount: 1 });
  }, 60_000);

  test("pages are by slug, offset paged, and only the store's own", async () => {
    expect((await b.pages("shared", { offset: 0, limit: 2 })).map((p) => p.slug)).toEqual(["notes/a", "notes/b"]);
    const rest = await b.pages("shared", { offset: 2, limit: 2 });
    expect(rest.map((p) => p.slug)).toEqual(["notes/c"]);
    expect(typeof rest[0]!.updatedAt).toBe("number");
    expect((await b.pages("user-ualice", { offset: 0, limit: 10 })).map((p) => p.slug)).toEqual(["notes/secret"]);
  }, 60_000);

  test("a page with content, type, tags and links; another store's page is not found", async () => {
    const p = await b.page("shared", "notes/b");
    expect(p).toMatchObject({ store: "shared", slug: "notes/b", type: "note", tags: ["ops"] });
    expect(p!.content).toContain("See [A](notes/a)");
    expect(p!.links).toContainEqual({ to: "notes/a", type: "see_also", context: "for more" });
    expect(await b.page("shared", "notes/secret")).toBeNull();
    expect(await b.page("shared", "notes/none")).toBeNull();
  }, 60_000);
});

describe("availability and naming", () => {
  test("disabled or remote is unavailable, with a reason", () => {
    expect(memoryUnavailableReason()).toBeNull();
    process.env.SLAUDE_BRAIN_DISABLED = "1";
    expect(memoryUnavailableReason()).toContain("disabled");
    delete process.env.SLAUDE_BRAIN_DISABLED;
    process.env.SLAUDE_BRAIN_MODE = "remote";
    expect(memoryUnavailableReason()).toContain("separate brain server");
    delete process.env.SLAUDE_BRAIN_MODE;
  });

  test("kinds and labels follow the source naming", () => {
    expect(["agent", "agent-uscout", "shared", "public", "user-ualice", "profile-tteam-ualice", "kb-handbook", "default"].map(storeKind))
      .toEqual(["agent", "agent", "shared", "public", "personal", "profile", "library", "other"]);
    expect(storeLabel("agent-uscout", new Map([["agent-uscout", "scout"]]))).toBe("Agent mind: scout");
    expect(storeLabel("kb-handbook")).toBe("Library: handbook");
    expect(storeLabel("user-ualice")).toBe("Personal: ualice");
  });
});
