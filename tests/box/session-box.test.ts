/**
 * A node's view of a session's box: the pinned digest from the session view,
 * the current policy from the bundle, and egress rules read fresh at every
 * call (a fake bundle source stands in for the node's bundle cache).
 */
import { describe, expect, test } from "bun:test";
import { makeSessionBoxSource, type BundleBoxFacts } from "../../src/box/session-box";
import { defaultBoxPolicy } from "../../src/box/policy";
import { BootFailure } from "../../src/gateway/core/failure-codes";

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const bundleBox = (c: string, allow: string[] = []): BundleBoxFacts => ({
  name: "ruby-dev",
  image: `ghcr.io/example/boxes/ruby-dev@${digest(c)}`,
  digest: digest(c),
  policy: { ...defaultBoxPolicy(), egress: { allow, deny: [] } },
});

function sources(o: { box?: BundleBoxFacts | null; pin?: { box_name?: string | null; box_digest?: string | null } | null }) {
  const state = { box: o.box ?? null, pin: o.pin === undefined ? null : o.pin, bundleReads: 0 };
  const source = makeSessionBoxSource({
    bundle: async () => {
      state.bundleReads++;
      return state.box ? { box: state.box } : {};
    },
    session: async () => state.pin,
  });
  return { state, source };
}

const failure = async (p: Promise<unknown>) => {
  const e = await p.catch((x) => x);
  expect(e).toBeInstanceOf(BootFailure);
  expect((e as BootFailure).code).toBe("BOX_UNAVAILABLE");
  return (e as Error).message;
};

describe("makeSessionBoxSource", () => {
  test("no box in the bundle and no pin: the session is not boxed", async () => {
    expect(await sources({}).source.boxOf("S1")).toBeNull();
    expect(await sources({ pin: { box_name: null, box_digest: null } }).source.boxOf("S1")).toBeNull();
  });

  test("the digest is the session's pin, never the bundle's current one; the policy is the bundle's", async () => {
    const { source } = sources({ box: bundleBox("b", ["pypi.org"]), pin: { box_name: "ruby-dev", box_digest: digest("a") } });
    const box = (await source.boxOf("S1"))!;
    expect(box.digest).toBe(digest("a"));
    expect(box.image).toBe(`ghcr.io/example/boxes/ruby-dev@${digest("a")}`);
    expect(box.policy.egress.allow).toEqual(["pypi.org"]);
    expect(box.name).toBe("ruby-dev");
  });

  test("a session on the current digest runs the bundle's image", async () => {
    const { source } = sources({ box: bundleBox("a"), pin: { box_name: "ruby-dev", box_digest: digest("a") } });
    expect((await source.boxOf("S1"))!.image).toBe(bundleBox("a").image);
  });

  test("a disagreement between the two sources fails the boot; it never means 'unboxed'", async () => {
    expect(await failure(sources({ box: bundleBox("a") }).source.boxOf("S1"))).toMatch(/not pinned to a digest/);
    expect(await failure(sources({ pin: { box_name: "ruby-dev", box_digest: digest("a") } }).source.boxOf("S1"))).toMatch(/its persona's bundle carries none/);
    expect(await failure(sources({ box: bundleBox("a"), pin: { box_name: "py-dev", box_digest: digest("a") } }).source.boxOf("S1"))).toMatch(/a different box/);
    const bad = { ...bundleBox("a"), image: "not-a-reference" };
    expect(await failure(sources({ box: bad, pin: { box_name: "ruby-dev", box_digest: digest("a") } }).source.boxOf("S1"))).toMatch(/not a digest reference/);
  });

  test("an allowlist change reaches a running session at its next connection, with no restart", async () => {
    const { state, source } = sources({ box: bundleBox("a", ["github.com"]), pin: { box_name: "ruby-dev", box_digest: digest("a") } });
    const started = (await source.boxOf("S1"))!;
    expect(await source.egressOf("S1")).toEqual({ allow: ["github.com"], deny: [] });
    // The gateway synced a policy-only change; the node's bundle cache was invalidated by the reload announcement.
    state.box = { ...bundleBox("a", ["github.com", "pypi.org"]), policy: { ...defaultBoxPolicy(), egress: { allow: ["github.com", "pypi.org"], deny: ["uploads.github.com"] } } };
    expect(await source.egressOf("S1")).toEqual({ allow: ["github.com", "pypi.org"], deny: ["uploads.github.com"] });
    // The sandbox was not asked for again, and what it started with is untouched.
    expect(started.policy.egress.allow).toEqual(["github.com"]);
    expect(started.digest).toBe(digest("a"));
    // A removed host is gone at the next connection too.
    state.box = bundleBox("a", ["pypi.org"]);
    expect((await source.egressOf("S1")).allow).toEqual(["pypi.org"]);
  });

  test("the rules are read from the bundle source on every call, and the answer is a copy", async () => {
    const { state, source } = sources({ box: bundleBox("a", ["github.com"]) });
    const first = await source.egressOf("S1");
    first.allow.push("attacker.example.com");
    expect(await source.egressOf("S1")).toEqual({ allow: ["github.com"], deny: [] });
    expect(state.bundleReads).toBe(2);
  });

  test("a bundle that no longer carries the box refuses everything", async () => {
    const { state, source } = sources({ box: bundleBox("a", ["github.com"]) });
    state.box = null;
    expect(await source.egressOf("S1")).toEqual({ allow: [], deny: [] });
  });
});
