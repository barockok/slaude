/**
 * The person-slice decision sites (slice F). Every place that asks the resolver
 * what a person may read names itself with one of these ids, so a metric label,
 * a log line and the guard test (tests/slices/no-string-slice.test.ts) agree.
 * A site is listed here once its call is wired through `decidePersonSlices`.
 */
export const SLICE_SITES = [
  { id: "brain.gate_speaker", where: "brainGateFor: the turn speaker's slice reads (KB scope lock-owner branch, memory DM branch)" },
  { id: "memory.claims_run_as", where: "memoryScopeForClaims: the job token's runAs person (memory scope runAs branch)" },
] as const;

export type SliceSiteId = (typeof SLICE_SITES)[number]["id"];
