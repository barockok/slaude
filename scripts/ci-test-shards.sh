#!/usr/bin/env bash
# Run the bun test suite in a few separate processes ("shards") and apply the
# same pass/fail guard the single-process CI jobs use, per shard and in total.
#
# Why: on PGLite every test file shares one process, and the WASM runtime of a
# later PGLite instance can fail to allocate ("PGLite failed to initialize its
# WASM runtime ... Out of memory") once enough of the suite has run before it.
# Splitting the run gives each shard a fresh process. Every test file lands in
# exactly one shard; the script refuses to run if the shards do not cover the
# same files `bun test` would discover.
#
# Usage: scripts/ci-test-shards.sh <output-file>
#   env SUITE_PASS_FLOOR  minimum total passes (default 1400)
#   env BUN               bun binary (default: bun)
set -uo pipefail

out=${1:?usage: ci-test-shards.sh <output-file>}
floor=${SUITE_PASS_FLOOR:-1400}
bun_bin=${BUN:-bun}
config=bunfig.ci-shard.toml
: >"$out"

# Every file `bun test` discovers here (bunfig ignores tests/panel-web).
all_files() {
  git ls-files -- '*.test.ts' '*.test.tsx' '*_test.ts' '*.spec.ts' '*_spec.ts' \
    | grep -v '/panel-web/' | sort
}

# Shard 1: the gateway suite. Shard 2: the suites that open the most PGLite
# databases. Shard 3: everything else. tests/node shares process-wide state
# (a mocked SDK module, warm sessions) that breaks tests/brain-migrate when it
# runs first in the same process, so the two stay in different shards.
heavy='^tests/(db|brain-migrate|deploy|panel|persona|cli)/'
shard_files() {
  case "$1" in
    1) all_files | grep -E '^tests/gateway/' ;;
    2) all_files | grep -E "$heavy" ;;
    3) all_files | grep -vE '^tests/gateway/' | grep -vE "$heavy" ;;
  esac
}

total=$(all_files | wc -l)
covered=$( { shard_files 1; shard_files 2; shard_files 3; } | sort -u | wc -l)
if [ "$total" -ne "$covered" ]; then
  echo "::error::test shards cover ${covered} of ${total} test files"; exit 1
fi

passes_total=0
failed=0
for s in 1 2 3; do
  shard_out=$(mktemp)
  mapfile -t files < <(shard_files "$s")
  echo "::group::test shard ${s}/3 (${#files[@]} files)"
  "$bun_bin" --config="$config" test "${files[@]}" 2>&1 | tee "$shard_out"
  code=${PIPESTATUS[0]}
  echo "::endgroup::"
  cat "$shard_out" >>"$out"
  fails=$(grep -oE '^[[:space:]]*[0-9]+ fail' "$shard_out" | grep -oE '[0-9]+' | tail -1)
  fails=${fails:-0}
  passes=$(grep -oE '^[[:space:]]*[0-9]+ pass' "$shard_out" | grep -oE '[0-9]+' | tail -1)
  passes=${passes:-0}
  echo "shard ${s}: bun exit code ${code}; ${passes} passed; ${fails} failed"
  if [ "$fails" -ne 0 ]; then
    grep -E '^\(fail\)' "$shard_out" | sort -u
    echo "::error::${fails} test(s) failed in shard ${s}"
    failed=1
  fi
  # bun 1.3.11 can exit 99/100 with zero failures (PGLite's quit handler sets
  # process.exitCode); tolerate only that, and only without a crash marker.
  if [ "$code" -ne 0 ]; then
    if [ "$code" -ne 99 ] && [ "$code" -ne 100 ]; then
      [ "$fails" -ne 0 ] || echo "::error::shard ${s}: bun exited ${code} (not 0/99/100), treating it as a crash"
      failed=1
    elif grep -qiE 'panic|segmentation fault|SIGSEGV|SIGABRT|illegal instruction|bus error' "$shard_out"; then
      echo "::error::shard ${s}: crash marker in test output, refusing to tolerate exit ${code}"
      failed=1
    fi
  fi
  passes_total=$((passes_total + passes))
  rm -f "$shard_out"
done

[ "$failed" -eq 0 ] || exit 1
if [ "$passes_total" -lt "$floor" ]; then
  echo "::error::only ${passes_total} passes (expected >= ${floor}): the suite ran partially"; exit 1
fi
echo "tests passed (${passes_total} pass, 0 fail, 3 shards)"
