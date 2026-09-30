/**
 * The static server both web apps share. Its job is small and its failure modes
 * are not: a traversal escape serves the operator's filesystem, and a cached
 * shell leaves browsers asking for assets a deploy has already removed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticApp } from "../../src/gateway/static";

let root: string;
let built: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "slaude-static-"));
  // A built app: web/dist with a shell and a hashed asset.
  built = join(root, "built");
  mkdirSync(join(built, "dist", "assets"), { recursive: true });
  writeFileSync(join(built, "dist", "index.html"), "<!doctype html><title>built</title>");
  writeFileSync(join(built, "dist", "assets", "app-abc123.js"), "console.log(1)");
  // An unbuilt app: the source shell only.
  mkdirSync(join(root, "unbuilt"), { recursive: true });
  writeFileSync(join(root, "unbuilt", "index.html"), "<!doctype html><title>source</title>");
  // A file outside any root, for the traversal check to reach for.
  writeFileSync(join(root, "secret.txt"), "not yours");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

for (const prefix of ["/panel", "/portal"]) {
  describe(`serving under ${prefix}`, () => {
    const app = () => createStaticApp(built, prefix);

    test("the mount root serves the shell", async () => {
      const res = await app().serve(prefix);
      expect(await res!.text()).toContain("built");
    });

    test("the shell is not cached", async () => {
      const res = await app().serve(`${prefix}/`);
      expect(res!.headers.get("cache-control")).toBe("no-cache");
    });

    test("hashed assets are immutable", async () => {
      const res = await app().serve(`${prefix}/assets/app-abc123.js`);
      expect(res!.status).toBe(200);
      expect(res!.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    });

    test("an extension-less client route falls back to the shell", async () => {
      const res = await app().serve(`${prefix}/settings/integrations`);
      expect(await res!.text()).toContain("built");
    });

    test("a missing file with an extension is not found", async () => {
      expect(await app().serve(`${prefix}/assets/gone-000000.js`)).toBeNull();
    });

    test("traversal outside the root is refused", async () => {
      for (const p of [`${prefix}/../secret.txt`, `${prefix}/assets/../../secret.txt`, `${prefix}/%2e%2e/secret.txt`]) {
        const res = await app().serve(p);
        expect(res === null || res.status === 403).toBe(true);
        if (res) expect(await res.text()).not.toContain("not yours");
      }
    });
  });
}

describe("an app that has not been built", () => {
  test("serves the source shell rather than nothing", async () => {
    const res = await createStaticApp(join(root, "unbuilt"), "/portal").serve("/portal");
    expect(await res!.text()).toContain("source");
  });
});
