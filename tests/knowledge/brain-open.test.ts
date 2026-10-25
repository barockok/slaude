// The message hot path reads only a brain that is already open: brainReady()
// says whether it is, and brainCallIfOpen never boots or connects one.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainCallIfOpen, brainHome, brainReady, closeBrain, getBrain } from "../../src/knowledge/brain";
import { resetBackend } from "../../src/knowledge/backend";
import { RemoteBackend } from "../../src/knowledge/remote/brain-client";
import type { BrainScope } from "../../src/knowledge/scope";

const root = mkdtempSync(join(tmpdir(), "brain-open-"));
const saved = { home: process.env.SLAUDE_BRAIN_HOME, mode: process.env.SLAUDE_BRAIN_MODE };
const scope: BrainScope = { clientId: "t", sourceId: "shared", allowedSources: ["shared"] };

afterAll(async () => {
  await closeBrain();
  resetBackend();
  if (saved.home === undefined) delete process.env.SLAUDE_BRAIN_HOME; else process.env.SLAUDE_BRAIN_HOME = saved.home;
  if (saved.mode === undefined) delete process.env.SLAUDE_BRAIN_MODE; else process.env.SLAUDE_BRAIN_MODE = saved.mode;
  rmSync(root, { recursive: true, force: true });
});

test("local: a brain never booted is not ready, and brainCallIfOpen refuses without booting it", async () => {
  await closeBrain();
  resetBackend();
  delete process.env.SLAUDE_BRAIN_MODE;
  process.env.SLAUDE_BRAIN_HOME = join(root, "cold");
  expect(brainReady()).toBe(false);
  const err = await brainCallIfOpen("get_page", { slug: "x" }, scope).then(() => null, (e) => e);
  expect((err as { code?: string } | null)?.code).toBe("brain_not_open");
  // boot() creates the brain home before anything else: it never ran.
  expect(existsSync(brainHome())).toBe(false);
  expect(brainReady()).toBe(false);
});

test("local: ready once the engine is open, not ready again after closeBrain", async () => {
  await closeBrain();
  resetBackend();
  delete process.env.SLAUDE_BRAIN_MODE;
  process.env.SLAUDE_BRAIN_HOME = join(root, "warm");
  const booting = getBrain();
  expect(brainReady()).toBe(false); // still booting: not open yet
  await booting;
  expect(brainReady()).toBe(true);
  expect(Array.isArray(await brainCallIfOpen("list_pages", { limit: 1 }, scope))).toBe(true);
  const closing = closeBrain();
  expect(brainReady()).toBe(false); // closing: the hot path stops at once
  await closing;
  expect(brainReady()).toBe(false);
}, 120_000);

test("remote: not ready before a connect, and an if-open call never connects", async () => {
  let fetched = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...a: Parameters<typeof fetch>) => {
    fetched++;
    return realFetch(...a);
  }) as typeof fetch;
  try {
    const b = new RemoteBackend("http://127.0.0.1:9/mcp");
    expect(b.ready()).toBe(false);
    const err = await b.call("get_page", { slug: "x" }, scope, { ifOpen: true }).then(() => null, (e) => e);
    expect((err as { code?: string } | null)?.code).toBe("brain_not_open");
    expect(b.ready()).toBe(false);
    expect(fetched).toBe(0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
