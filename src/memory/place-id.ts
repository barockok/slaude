/**
 * The naming of memory place sources: the ONLY file that builds or recognises an `mb-` id
 * (a guard test fails on any other file that names the prefix). It holds nothing but pure
 * string functions and imports nothing from the app, so `src/knowledge/scope.ts` can use it
 * without a cycle; `src/memory/place.ts` re-exports it and owns the resolver.
 *
 * A place source is `mb-` plus the first 28 hex characters of sha256(agentId, NUL, boundaryId):
 * 31 characters, inside gbrain's `[a-z0-9-]{1,32}`, deterministic so replicas agree without
 * coordination.
 */
import { createHash } from "node:crypto";

const PLACE_PREFIX = "mb-";

/** `mb-` + first 28 hex chars of sha256(agentId + NUL + boundaryId). */
export function placeSourceId(agentId: string, boundaryId: string): string {
  return PLACE_PREFIX + createHash("sha256").update(agentId + "\0" + boundaryId).digest("hex").slice(0, 28);
}

/** True for a name `placeSourceId` could have produced. */
export const isPlaceSourceId = (s: string): boolean => /^mb-[0-9a-f]{28}$/.test(s);

/** True for any source named in the place family (the prefix alone). Recognition, never construction. */
export const hasPlacePrefix = (s: string): boolean => s.startsWith(PLACE_PREFIX);

/** The first characters of a place source after its prefix, for a console label. */
export const placeShortId = (s: string): string => s.slice(PLACE_PREFIX.length, PLACE_PREFIX.length + 8);
