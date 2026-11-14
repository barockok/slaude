#!/usr/bin/env bash
# Scripted smoke for the access decision sites (slice C, task 18).
#
# Runs tests/access/site-smoke.test.ts under SLAUDE_ACCESS_SOURCE=shadow: every
# site in src/access/sites.ts is driven through its real code path (functions
# and a fake-Slack gateway) and must count a decision in
# slaude_access_decision_total{site}. Prints each site with its count, then the
# sites no scripted path reaches ("live only", with the reason). Exit status is
# nonzero when a site neither counted nor is listed as live only.
#
# Usage: scripts/verify-access-sites.sh            # sqlite
#        SLAUDE_DB=pg scripts/verify-access-sites.sh
set -euo pipefail
cd "$(dirname "$0")/.."

report="$(mktemp -t access-sites.XXXXXX)"
trap 'rm -f "$report"' EXIT

status=0
SLAUDE_ACCESS_SOURCE=shadow SLAUDE_SMOKE_REPORT="$report" bun test tests/access/site-smoke.test.ts >"$report.log" 2>&1 || status=$?
trap 'rm -f "$report" "$report.log"' EXIT

if [ ! -s "$report" ]; then
  echo "smoke did not produce a report:" >&2
  grep -vE '^\{"ts"|^ (src|tests)/|^-+\|' "$report.log" | tail -40 >&2
  exit 1
fi

bun -e '
const rows = JSON.parse(await Bun.file(process.argv[1]).text());
const pad = (s, n) => String(s).padEnd(n);
console.log(pad("site", 52), pad("group", 6), pad("kind", 10), "decisions");
for (const r of rows) console.log(pad(r.id, 52), pad(r.group, 6), pad(r.kind, 10), r.count);
const zero = rows.filter((r) => r.count === 0);
const live = zero.filter((r) => r.live);
const missing = zero.filter((r) => !r.live);
console.log(`\n${rows.length} sites, ${rows.length - zero.length} counted by the scripted smoke`);
if (live.length) {
  console.log("\nlive only (read the production /metrics for these before the flip):");
  for (const r of live) console.log(`  ${r.id}: ${r.live}`);
}
if (missing.length) {
  console.log("\nSITES WITH NO DECISION AND NO REASON:");
  for (const r of missing) console.log(`  ${r.id}`);
}
' "$report"

if [ "$status" -ne 0 ]; then
  echo "site smoke test failed (exit $status):" >&2
  grep -vE '^\{"ts"|^ (src|tests)/|^-+\|' "$report.log" | tail -40 >&2
  exit "$status"
fi
