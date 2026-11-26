#!/usr/bin/env bash
set -e
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bubblewrap umoci skopeo zstd ripgrep golang-go erofs-utils unzip curl ca-certificates npm nodejs python3-venv python3-pip libcap2-bin git 2>&1 | tail -5 || true
cd /tmp
RUNSC_VERSION=${RUNSC_VERSION:-20261116.0}
URL=https://storage.googleapis.com/gvisor/releases/release/$RUNSC_VERSION/$(uname -m)
curl -fsSL -o gvisor.tar.zstd "$URL"/gvisor.tar.zstd; curl -fsSL -o gvisor.tar.zstd.sha512 "$URL"/gvisor.tar.zstd.sha512
sha512sum -c gvisor.tar.zstd.sha512
sha256sum gvisor.tar.zstd
rm -rf /tmp/gv && mkdir /tmp/gv && tar --zstd -xf gvisor.tar.zstd -C /tmp/gv
ls -la /tmp/gv
sudo install -m 0755 "$(find /tmp/gv -name runsc -type f | head -1)" /usr/local/bin/runsc
# newer releases look for helper binaries in gvisor-bin/ beside runsc
sudo rm -rf /usr/local/bin/gvisor-bin && sudo cp -r "$(dirname "$(find /tmp/gv -name runsc -type f | head -1)")/gvisor-bin" /usr/local/bin/
sha256sum /usr/local/bin/runsc
runsc --version
which bwrap umoci skopeo mkfs.erofs zstd rg go node npm
