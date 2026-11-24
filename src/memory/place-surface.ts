/**
 * The places design table (spec section 1, "Defaults per turn") as code: one entry per kind of
 * turn or surface, and what its default write is. Nothing in rc.45 decides on this; it exists so
 * that adding a kind of turn is a compile error until its row is written (the switch ends in
 * `never`), and so the table test in tests/memory/place-table.test.ts has one list to walk.
 *
 * Add a kind: extend `PLACE_TURN_KINDS`, answer `designDefaultWrite` for it (the compiler
 * insists), then add its row to the table test (a test insists).
 */
export const PLACE_TURN_KINDS = [
  "slack-channel",
  "dm-manager",
  "dm-other",
  "one-on-one",
  "public-channel-other",
  "public-channel-manager",
  "wake-with-place",
  "job-no-place",
  "nightly-pass",
  "voice-in-thread",
] as const;

export type PlaceTurnKind = (typeof PLACE_TURN_KINDS)[number];

/**
 * Where the kind's default durable write goes under the design:
 *  - `place`: the turn's place source;
 *  - `person`: the speaker's own `user-<id>` slice (the place is not used);
 *  - `place-transcript-only`: durable saves are denied, the transcript goes to the place;
 *  - `none`: no place, so (per the owner's decision 6, from rc.46 on) the persona-wide tier.
 */
export type DesignDefaultWrite = "place" | "person" | "place-transcript-only" | "none";

export function designDefaultWrite(kind: PlaceTurnKind): DesignDefaultWrite {
  switch (kind) {
    case "slack-channel":
    case "dm-manager":
    case "public-channel-manager":
    case "wake-with-place":
    case "nightly-pass":
    case "voice-in-thread":
      return "place";
    case "dm-other":
    case "one-on-one":
      return "person";
    case "public-channel-other":
      return "place-transcript-only";
    case "job-no-place":
      return "none";
    default: {
      const unhandled: never = kind;
      throw new Error(`no design default for turn kind ${String(unhandled)}`);
    }
  }
}
