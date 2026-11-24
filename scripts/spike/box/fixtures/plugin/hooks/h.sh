#!/bin/sh
# runs inside the sandbox from a read-only mount; proves a plugin hook script executes there
echo "hook ran as $(id -u) in $(pwd) at $(date +%s)" >> "${SPIKE_HOOK_MARKER:-/tmp/hook.marker}"
cat > /dev/null
exit 0
