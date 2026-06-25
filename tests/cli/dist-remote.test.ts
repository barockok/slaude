// tests/cli/dist-remote.test.ts
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { resolveLatestVersion, verifyChecksum } from "../../src/cli/dist";

function fakeFetch(body: any, ok = true): any {
  return async () => ({ ok, json: async () => body });
}

test("resolveLatestVersion strips the leading v from tag_name", async () => {
  const v = await resolveLatestVersion(fakeFetch({ tag_name: "v0.31.0" }));
  expect(v).toBe("0.31.0");
});

test("resolveLatestVersion throws on a bad response", async () => {
  await expect(resolveLatestVersion(fakeFetch({}, false))).rejects.toThrow("latest release");
});

test("verifyChecksum matches the sha256 line for the file", () => {
  const bytes = new TextEncoder().encode("hello slaude");
  const sum = createHash("sha256").update(bytes).digest("hex");
  const sums = `${sum}  slaude-0.31.0.tar.gz\n${"0".repeat(64)}  other.txt\n`;
  expect(verifyChecksum(bytes, sums, "slaude-0.31.0.tar.gz")).toBe(true);
  expect(verifyChecksum(bytes, sums, "other.txt")).toBe(false);
  expect(verifyChecksum(bytes, sums, "missing.txt")).toBe(false);
});

test("verifyChecksum rejects a suffix/embedded-space filename collision", () => {
  const bytes = new TextEncoder().encode("payload");
  const sum = createHash("sha256").update(bytes).digest("hex");
  // An entry whose name merely ends with the target must NOT match.
  const sums = `${sum}  x slaude-0.31.0.tar.gz\n${sum}  evil-slaude-0.31.0.tar.gz\n`;
  expect(verifyChecksum(bytes, sums, "slaude-0.31.0.tar.gz")).toBe(false);
  // Exact name still matches.
  const exact = `${sum}  slaude-0.31.0.tar.gz\n`;
  expect(verifyChecksum(bytes, exact, "slaude-0.31.0.tar.gz")).toBe(true);
});
