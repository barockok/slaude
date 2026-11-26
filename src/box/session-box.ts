/**
 * A node's view of one session's box: what the sandbox resolver and the
 * session's egress proxy read (box plan, Phase 3, "Node").
 *
 * Two sources, both from the gateway, neither chosen by the node:
 *   - the session view carries the PINNED digest (`box_name`, `box_digest`);
 *   - the runtime bundle carries the box's name and its CURRENT policy.
 *
 * The digest is read once per sandbox start. The policy is read on every call
 * through the node's bundle cache, which the tenant reload announcement
 * invalidates: an allowlist change reaches a running session's proxy at its
 * next connection, with no sandbox restart.
 *
 * Nothing here runs yet: the resolver and the proxy that call it arrive with
 * the sandbox driver. It holds no credential and reads none.
 */
import { BootFailure } from "../gateway/core/failure-codes";
import { isStandInImage } from "./definition";
import type { BoxEgress, BoxPolicy } from "./policy";

/** The box as a runtime bundle carries it. */
export interface BundleBoxFacts {
  name: string;
  /** `<repository>@sha256:<digest>` of the box's current version. */
  image: string;
  digest: string;
  policy: BoxPolicy;
}

export interface SessionBoxFacts {
  name: string;
  /** The image to run: the bundle's repository at the session's pinned digest. */
  image: string;
  /** The pinned digest. */
  digest: string;
  policy: BoxPolicy;
}

export interface SessionBoxSources {
  /** The session's runtime bundle, through the node's cache. */
  bundle: (sessionId: string) => Promise<{ box?: BundleBoxFacts | null }>;
  /** The session row as the gateway's session view returns it. */
  session: (sessionId: string) => Promise<{ box_name?: string | null; box_digest?: string | null } | null>;
}

const unavailable = (why: string) => new BootFailure("BOX_UNAVAILABLE", why);

export function makeSessionBoxSource(src: SessionBoxSources): {
  /** The session's box, or null when it is not boxed. Throws BootFailure when the two sources disagree: never "run unboxed". */
  boxOf(sessionId: string): Promise<SessionBoxFacts | null>;
  /** The egress rules to judge the next connection by. Read fresh on every call. */
  egressOf(sessionId: string): Promise<BoxEgress>;
} {
  async function boxOf(sessionId: string): Promise<SessionBoxFacts | null> {
    const [bundle, row] = await Promise.all([src.bundle(sessionId), src.session(sessionId)]);
    const box = bundle.box ?? null;
    const pinned = row?.box_name && row.box_digest ? { name: row.box_name, digest: row.box_digest } : null;
    if (!box && !pinned) return null;
    // A boxed persona whose session has no pin, or a pinned session whose
    // persona's bundle has no box: one side is stale. Fail the boot.
    if (!box) throw unavailable("the session is pinned to a box, but its persona's bundle carries none");
    if (!pinned) throw unavailable("the persona runs in a box, but the session is not pinned to a digest");
    if (pinned.name !== box.name) throw unavailable("the session is pinned to a different box than its persona now names");
    const at = box.image.indexOf("@");
    if (at <= 0) throw unavailable("the bundle's box image is not a digest reference");
    // The gateway refuses to store one; a node does not start a session on one either.
    if (isStandInImage(pinned.digest) || isStandInImage(box.image)) throw unavailable("the box's image digest is a stand-in for an image that was never pushed");
    return { name: box.name, image: `${box.image.slice(0, at)}@${pinned.digest}`, digest: pinned.digest, policy: box.policy };
  }
  return {
    boxOf,
    async egressOf(sessionId) {
      const box = (await src.bundle(sessionId)).box;
      // No box in the bundle any more: refuse everything rather than keep the last rules.
      return box ? { allow: [...box.policy.egress.allow], deny: [...box.policy.egress.deny] } : { allow: [], deny: [] };
    },
  };
}
