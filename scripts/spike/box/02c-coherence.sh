#!/usr/bin/env bash
# Spike 2, C2 decision: does a sandbox with --file-access-mounts=exclusive notice host-side changes
# (what drainInbox does to a live workspace)? Adversarial cases: negative lookup cache, directory
# listing cache, in-place rewrite of cached file content, size change. Run as root after 01-run.sh's setup.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$HERE/lib.sh"
exec > >(tee "$RESULTS/02c-coherence.txt") 2>&1
prep_image
for mode in shared exclusive; do
  N=coh-$mode; B=$SPIKE/coh/$mode; rm -rf "$B"; mkdir -p "$B"/{home,ws,run,ov}; chown -R 1000:1000 "$B/home" "$B/ws"
  runsc --root "$RS" delete -force "$N" >/dev/null 2>&1
  mkspec "$N" "$B/home" "$B/ws" "$B/run"
  FL=(); [ $mode = exclusive ] && FL=(--file-access-mounts=exclusive)
  runsc --root "$RS" --platform "$PLATFORM" --network none --host-uds open "${FL[@]}" --overlay2 "root:dir=$B/ov,size=1g" run --detach --bundle "$SPIKE/specs/$N" "$N" </dev/null >/dev/null 2>&1
  sb() { runsc --root "$RS" exec --user 1000:1000 "$N" /bin/sh -c "$1" 2>&1; }
  mkdir -p "$B/ws/d"; echo one > "$B/ws/d/a"; head -c 10485760 /dev/zero | tr '\0' 'A' > "$B/ws/big"; echo -n hello > "$B/ws/grow"; chown -R 1000:1000 "$B/ws"
  # prime the sandbox's caches
  sb 'ls /work/d | wc -l; cat /work/d/a; test -e /work/d/new; echo neg=$?; md5sum /work/big | cut -c1-8; stat -c %s /work/grow' >/dev/null
  # host-side changes
  echo two > "$B/ws/d/new"                                              # new file in a listed dir, previously a negative lookup
  head -c 10485760 /dev/zero | tr '\0' 'B' | dd of="$B/ws/big" conv=notrunc 2>/dev/null   # same-size in-place rewrite
  echo -n " world" >> "$B/ws/grow"                                      # size change
  rm -f "$B/ws/d/a"                                                     # removal
  imm=$(sb 'echo list=$(ls /work/d | tr "\n" ","); test -e /work/d/new && echo newfile=visible || echo newfile=INVISIBLE; test -e /work/d/a && echo removed=STILL-THERE || echo removed=gone; echo big=$(md5sum /work/big | cut -c1-8) expect=$(head -c 10485760 /dev/zero | tr "\0" "B" | md5sum | cut -c1-8); echo grow_size=$(stat -c %s /work/grow) expect=11' | tr '\n' ' ')
  sleep 5
  late=$(sb 'echo list=$(ls /work/d | tr "\n" ","); test -e /work/d/new && echo newfile=visible || echo newfile=INVISIBLE; test -e /work/d/a && echo removed=STILL-THERE || echo removed=gone; echo big=$(md5sum /work/big | cut -c1-8); echo grow_size=$(stat -c %s /work/grow)' | tr '\n' ' ')
  echo "RESULT coherence/$mode | INFO | immediately: $imm | after 5 s: $late"
  runsc --root "$RS" delete -force "$N" >/dev/null 2>&1
done
