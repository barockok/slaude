/**
 * Stand-in digests: what `personas render --no-push` reports for an image no
 * registry holds. They are marked, so the gateway and a node can refuse one
 * without asking a registry.
 */
import { describe, expect, test } from "bun:test";
import { BOX_IMAGE_REF_RE, BOX_STAND_IN_DIGEST_PREFIX, isStandInImage, parseBoxPayload, standInDigestFor } from "../../src/box/definition";
import { standInDigest } from "../../src/cli/box";
import { defaultBoxPolicy } from "../../src/box/policy";
import { makeSessionBoxSource, type BundleBoxFacts } from "../../src/box/session-box";
import { BootFailure } from "../../src/gateway/core/failure-codes";

const real = (c: string) => `sha256:${c.repeat(64)}`;
const hash = "ab".repeat(32);

describe("stand-in digests", () => {
  test("a stand-in is a well-formed digest that carries the mark, and depends on the context hash", () => {
    const d = standInDigestFor(hash);
    expect(d).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(d.startsWith(BOX_STAND_IN_DIGEST_PREFIX)).toBe(true);
    expect(standInDigest(hash)).toBe(d);
    expect(standInDigestFor("cd".repeat(32))).not.toBe(d);
    expect(BOX_IMAGE_REF_RE.test(`ghcr.io/example/boxes/ruby-dev@${d}`)).toBe(true);
    // The payload schema accepts one: a dry run must be able to carry it.
    expect(parseBoxPayload({ name: "ruby-dev", image: `ghcr.io/example/boxes/ruby-dev@${d}` }).digest).toBe(d);
  });

  test("isStandInImage: a marked digest or the stand-in registry, as a digest or as an image reference", () => {
    const d = standInDigestFor(hash);
    expect(isStandInImage(d)).toBe(true);
    expect(isStandInImage(`ghcr.io/example/boxes/ruby-dev@${d}`)).toBe(true);
    expect(isStandInImage(`registry.invalid/boxes/ruby-dev@${real("a")}`)).toBe(true);
    expect(isStandInImage(`registry.invalid:5000/boxes/ruby-dev@${real("a")}`)).toBe(true);
    expect(isStandInImage(real("a"))).toBe(false);
    expect(isStandInImage(real("0"))).toBe(true);
    expect(isStandInImage(`ghcr.io/example/boxes/ruby-dev@${real("a")}`)).toBe(false);
    // A host that only starts with the same letters is a real registry.
    expect(isStandInImage(`registry.invalid.example.com/boxes/ruby-dev@${real("a")}`)).toBe(false);
    expect(isStandInImage(`sha256:${"0".repeat(23)}1${"a".repeat(40)}`)).toBe(false);
  });

  test("a node does not boot a session pinned to a stand-in, or one whose bundle names a stand-in image", async () => {
    const d = standInDigestFor(hash);
    const box = (image: string, digest: string): BundleBoxFacts => ({ name: "ruby-dev", image, digest, policy: defaultBoxPolicy() });
    const boxOf = (b: BundleBoxFacts, pinned: string) =>
      makeSessionBoxSource({ bundle: async () => ({ box: b }), session: async () => ({ box_name: "ruby-dev", box_digest: pinned }) }).boxOf("S1");

    const pinnedToStandIn = await boxOf(box(`ghcr.io/example/boxes/ruby-dev@${real("a")}`, real("a")), d).catch((e) => e);
    expect(pinnedToStandIn).toBeInstanceOf(BootFailure);
    expect((pinnedToStandIn as BootFailure).code).toBe("BOX_UNAVAILABLE");
    expect((pinnedToStandIn as Error).message).toContain("stand-in");

    expect(await boxOf(box(`registry.invalid/boxes/ruby-dev@${real("a")}`, real("a")), real("a")).catch((e) => e)).toBeInstanceOf(BootFailure);
    expect((await boxOf(box(`ghcr.io/example/boxes/ruby-dev@${real("a")}`, real("a")), real("a")))!.digest).toBe(real("a"));
  });
});
