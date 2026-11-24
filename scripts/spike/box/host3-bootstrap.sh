#!/usr/bin/env bash
# Run INSIDE a privileged pod on the target cluster (see host3-pod.yaml), as root, with this directory at /spike.
# Installs runsc (pinned, checksum-verified) and the small toolset, then runs Spike 1, the cgroup follow-up and
# the mini benchmark. Not run on a cluster by the author: the same script was run in a privileged docker container
# on the dev VM (host 2 stand-in) to check that it works end to end.
set -euo pipefail
RUNSC_VERSION=${RUNSC_VERSION:-20261116.0}
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 curl ca-certificates skopeo umoci golang-go zstd git procps iproute2 util-linux bubblewrap >/dev/null
ARCH=$(uname -m)
cd /tmp
base=https://storage.googleapis.com/gvisor/releases/release/$RUNSC_VERSION/$ARCH
curl -fsSL -o gvisor.tar.zstd "$base/gvisor.tar.zstd"; curl -fsSL -o gvisor.tar.zstd.sha512 "$base/gvisor.tar.zstd.sha512"
sha512sum -c gvisor.tar.zstd.sha512
rm -rf /tmp/gv && mkdir /tmp/gv && tar --zstd -xf gvisor.tar.zstd -C /tmp/gv
install -m 0755 "$(find /tmp/gv -name runsc -type f | head -1)" /usr/local/bin/runsc
rm -rf /usr/local/bin/gvisor-bin && cp -r "$(dirname "$(find /tmp/gv -name runsc -type f | head -1)")/gvisor-bin" /usr/local/bin/
runsc --version
mkdir -p /var/lib/slaude-spike
cd /spike
echo "== kernel / cgroup / kvm"; uname -a; stat -fc %T /sys/fs/cgroup; ls -l /dev/kvm 2>&1 || true; cat /proc/self/cgroup
bash 01-run.sh "${LABEL:-pod}"
bash probe-cgroup.sh "${LABEL:-pod}"
bash 02-mini.sh "${LABEL:-pod}" 3
echo "results are in /spike/results (01-run.${LABEL:-pod}.txt, 01b-cgroup.${LABEL:-pod}.txt, 02-mini.${LABEL:-pod}.tsv): copy them out with kubectl cp"
