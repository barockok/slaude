#!/usr/bin/env bash
# debug-brain-fk.sh — collect data to root-cause the kb_put_page FK failure
# (pages_source_id_fkey) seen on the maria-memory KB.
#
# SAFE: never opens the live brain. PGLite is single-writer and the running
# agent holds the lock, so we copy the data dir to /tmp and query the COPY.
# Read-only w.r.t. live state. Run this INSIDE the maria UAT pod.
#
#   kubectl exec -it <maria-pod> -- bash /path/to/debug-brain-fk.sh
#   # or: copy file in, then: bash debug-brain-fk.sh
#
set -uo pipefail

APP_DIR="${SLAUDE_APP_DIR:-/app}"
SLAUDE_HOME_DIR="${SLAUDE_HOME:-/data}"
BRAIN_HOME="${SLAUDE_BRAIN_HOME:-$SLAUDE_HOME_DIR/brain}"
BRAIN_DB="$BRAIN_HOME/db"
SNAP="/tmp/brain-fk-debug.$$"

line(){ printf '\n========== %s ==========\n' "$1"; }

line "ENV"
echo "APP_DIR        = $APP_DIR"
echo "SLAUDE_HOME    = $SLAUDE_HOME_DIR"
echo "BRAIN_HOME     = $BRAIN_HOME"
echo "BRAIN_DB (live)= $BRAIN_DB"
command -v bun >/dev/null && echo "bun            = $(bun --version 2>/dev/null)" || echo "bun            = NOT FOUND (script needs bun)"

if [ ! -d "$BRAIN_DB" ]; then
  echo "!! BRAIN_DB dir not found at $BRAIN_DB — adjust SLAUDE_BRAIN_HOME and re-run."
  ls -la "$BRAIN_HOME" 2>/dev/null || true
  exit 1
fi

line "SNAPSHOT (copy live brain → $SNAP, query the copy)"
cp -a "$BRAIN_DB" "$SNAP" || { echo "!! copy failed"; exit 1; }
# Drop any lock artifacts carried in the copy so PGlite opens the copy cleanly.
rm -rf "$SNAP/.gbrain-lock" "$SNAP"/*.lock "$SNAP"/lock 2>/dev/null || true
echo "snapshot ready: $SNAP"

line "MANIFEST: KBs in slaude.json / slaude.lock"
for f in "$SLAUDE_HOME_DIR/slaude.json" "$APP_DIR/slaude.json" "$SLAUDE_HOME_DIR/slaude.lock" "$APP_DIR/slaude.lock"; do
  [ -f "$f" ] || continue
  echo "--- $f"
  if command -v jq >/dev/null 2>&1; then
    jq '{kbs: (.kbs // .knowledge // .)}' "$f" 2>/dev/null || cat "$f"
  else
    grep -iE 'maria-memory|lending-business|label|"kbs"|knowledge' "$f" || cat "$f"
  fi
done

line "BRAIN SQL (against snapshot — read-only)"
SNAP_DIR="$SNAP" bun --cwd "$APP_DIR" - <<'JS'
const { PGlite } = await import("@electric-sql/pglite");
const dir = process.env.SNAP_DIR;
const db = await PGlite.create({ dataDir: dir });
const q = async (label, sql) => {
  try {
    const r = await db.query(sql);
    console.log(`\n# ${label}`);
    console.table ? console.table(r.rows) : console.log(JSON.stringify(r.rows, null, 2));
    console.log(JSON.stringify(r.rows));
  } catch (e) {
    console.log(`\n# ${label}\n!! query error: ${e.message}`);
  }
};

// 1) THE DECIDER — every registered source. Is kb-maria-memory present?
await q("sources (all rows)", "SELECT * FROM sources ORDER BY id");

// 2) page counts per source — which sources actually hold pages
await q("pages per source_id", "SELECT source_id, count(*) AS pages FROM pages GROUP BY source_id ORDER BY pages DESC");

// 3) any ITGC / maria-memory pages that DID land
await q("itgc / maria-memory pages",
  "SELECT source_id, slug, type, updated_at FROM pages WHERE slug ILIKE '%itgc%' OR slug ILIKE 'maria-memory%' ORDER BY updated_at DESC NULLS LAST LIMIT 50");

// 4) explicit existence check for the suspected-missing source
await q("kb-maria-memory present?",
  "SELECT EXISTS(SELECT 1 FROM sources WHERE id = 'kb-maria-memory') AS kb_maria_memory_exists, EXISTS(SELECT 1 FROM sources WHERE id = 'shared') AS shared_exists, EXISTS(SELECT 1 FROM sources WHERE id = 'kb-lending-business') AS kb_lending_exists");

// 5) the lesson page from Case 2 (proves write path works on lending-business)
await q("jot lesson page (case 2 control)",
  "SELECT source_id, slug, type, updated_at FROM pages WHERE slug = 'lessons/jot-deployment-pattern'");

await db.close();
JS

line "BOOT LOG HINT"
cat <<'TXT'
The "[brain] source bootstrap failed" / "[brain] kb wiki indexed: maria-memory"
lines go to STDOUT, not disk — fetch them from outside the pod:

  kubectl logs <maria-pod> --since=72h | grep -iE '\[brain\]|source bootstrap|kb wiki indexed'
  # if the pod restarted: add  -p  for the previous container.

TXT

line "CLEANUP"
rm -rf "$SNAP" && echo "removed snapshot $SNAP"
echo "done."
