#!/usr/bin/env bash
# Spike 2, C3 follow-up: can this runsc start a sandbox whose root is an EROFS image? Tries the
# annotation spellings and overlay media and records each outcome. Run as root after 02-setup-bench.sh.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/spike/box/lib.sh
source "$HERE/lib.sh"
exec > >(tee "$RESULTS/02b-erofs.txt") 2>&1
IMG=$SPIKE/bench.erofs
try() { # try NAME overlay-annotation overlay2-flag init
  local n=$1 ann=$2 flag=$3 init=${4:-sleep}
  local B=$SPIKE/erofs/$n; rm -rf "$B"; mkdir -p "$B"/{home,ws,run,ov}
  runsc --root "$RS" delete -force "e-$n" >/dev/null 2>&1
  if [ "$init" = probe ]; then export BOX_INIT=1; else unset BOX_INIT; fi
  ROOTFS=$SPIKE/bench-root mkspec "e-$n" "$B/home" "$B/ws" "$B/run"
  python3 - "$SPIKE/specs/e-$n/config.json" "$IMG" "$ann" <<'PY'
import json,sys
p,img,ann=sys.argv[1:4]
c=json.load(open(p))
a={"dev.gvisor.spec.rootfs.source":img,"dev.gvisor.spec.rootfs.type":"erofs"}
if ann!="-": a["dev.gvisor.spec.rootfs.overlay"]=ann
c["annotations"]=a
c["process"]["args"]=["/usr/bin/sleep","infinity"] if "usrbin" in p else c["process"]["args"]
json.dump(c,open(p,"w"),indent=1)
PY
  local fl=(); [ "$flag" != "-" ] && fl=(--overlay2 "$flag")
  if out=$(runsc --root "$RS" --platform "$PLATFORM" --network none --host-uds open "${fl[@]}" run --detach --bundle "$SPIKE/specs/e-$n" "e-$n" </dev/null 2>&1); then
    echo "RESULT erofs/$n | PASS | started; exec: $(runsc --root "$RS" exec "e-$n" /bin/sh -c 'echo hi; mount | head -3' 2>&1 | tr '\n' ' ' | cut -c1-200)"
  else
    echo "RESULT erofs/$n | FAIL | $(echo "$out" | grep -m1 -E "panic|Error|error|failed" | cut -c1-260)"
  fi
  runsc --root "$RS" delete -force "e-$n" >/dev/null 2>&1
}
try dir-sleep "dir=$SPIKE/erofs/dir-sleep/ov" - sleep
try dir-probe "dir=$SPIKE/erofs/dir-probe/ov" - probe
try both-flag-and-annotation "dir=$SPIKE/erofs/both-flag-and-annotation/ov" "root:dir=$SPIKE/erofs/both-flag-and-annotation/ov,size=2g" sleep
try self-sleep "self" - sleep
try memory-sleep "memory" - sleep
try none-sleep - - sleep
try usrbin-none - - sleep
try usrbin-self self - sleep
