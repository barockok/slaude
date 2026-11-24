# Shared helpers for the box spikes. Source this file; it assumes root (sudo) inside a Linux VM.
# Work area: SPIKE (default /var/lib/slaude-spike), on the VM's own disk (not a host mount).
SPIKE=${SPIKE:-/var/lib/slaude-spike}
RS=${RS:-$SPIKE/rs}            # runsc --root
BUNDLE=${BUNDLE:-$SPIKE/bundle}
RESULTS=${RESULTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/results}
PLATFORM=${PLATFORM:-systrap}

now_ms() { date +%s%3N; }

# prep_image: debian:bookworm-slim -> $SPIKE/image (oci layout) -> $BUNDLE/rootfs (umoci unpack, rootless-free as root)
prep_image() {
  mkdir -p "$SPIKE"
  if [ ! -d "$BUNDLE/rootfs" ]; then
    [ -d "$SPIKE/oci" ] || skopeo copy docker://docker.io/library/debian:bookworm-slim oci:"$SPIKE/oci":latest
    umoci unpack --image "$SPIKE/oci":latest "$BUNDLE"
  fi
}

# mkspec NAME HOMEDIR WSDIR RUNDIR MEM_BYTES PIDS CPU_QUOTA -> writes $SPIKE/specs/NAME/config.json (bundle with shared rootfs by symlink path)
# The rootfs path is shared by every sandbox (read-only root, per-sandbox overlay), as in the design.
mkspec() {
  local name=$1 home=$2 ws=$3 run=$4 mem=${5:-0} pids=${6:-0} quota=${7:-0}
  local d=$SPIKE/specs/$name; mkdir -p "$d"
  python3 - "$BUNDLE/config.json" "$d/config.json" "${ROOTFS:-$BUNDLE/rootfs}" "$home" "$ws" "$run" "$mem" "$pids" "$quota" <<'PY'
import json,sys,os
src,dst,root,home,ws,run,mem,pids,quota=sys.argv[1:]
c=json.load(open(src))
c["root"]={"path":root,"readonly":False}  # the image dir is never written: the root overlay takes every write (verified in 01-run.sh)
c["process"]["terminal"]=False
c["process"]["args"]=["/usr/local/bin/box-probe","init"] if os.environ.get("BOX_INIT") else ["/bin/sleep","infinity"]
c["process"]["noNewPrivileges"]=True
c["process"]["cwd"]="/"
import os
c["process"]["user"]={"uid":1000,"gid":1000}
# drop every capability
if not os.environ.get("KEEPCAPS"):
    c["process"]["capabilities"]={k:[] for k in ("bounding","effective","inheritable","permitted","ambient")}
mounts=[m for m in c.get("mounts",[]) if m["destination"] in ("/proc","/dev","/dev/pts","/dev/shm","/sys")]
same=bool(os.environ.get("SAMEPATH"))
for src_,dst_ in ((home,home if same else "/home/agent"),(ws,ws if same else "/work"),(run,"/run/slaude")):
    mounts.append({"destination":dst_,"type":"bind","source":src_,"options":["rbind","rw"]})
for em in os.environ.get("EXTRA_MOUNTS","").split():
    a,b=em.split(":")
    mounts.append({"destination":b,"type":"bind","source":a,"options":["rbind","ro"]})
mounts.append({"destination":"/tmp","type":"tmpfs","source":"tmpfs","options":["nosuid","size=512m"]})
c["mounts"]=mounts
res={}
if int(mem): res["memory"]={"limit":int(mem)}
if int(pids): res["pids"]={"limit":int(pids)}
if int(quota): res["cpu"]={"quota":int(quota),"period":100000}
c.setdefault("linux",{})["resources"]=res
c["linux"]["namespaces"]=[{"type":t} for t in ("pid","ipc","uts","mount","network")]
c.pop("hooks",None)
json.dump(c,open(dst,"w"),indent=1)
PY
}

# rsc: runsc with the design's flags
rsc() { sudo runsc --root "$RS" --platform "$PLATFORM" --network none "${EXTRA[@]}" "$@"; }

# cg_delegate: inside a container with a private cgroup namespace (a node pod, docker --privileged), the
# container's own cgroup holds processes, and cgroup v2 forbids enabling controllers for children
# while it does ("no internal processes"). Move them to /init, enable the controllers. No-op on a
# normal host (systemd already delegates). Sets CGSURR to the cgroup directory the sandbox memory
# should be charged to.
cg_delegate() {
  local self; self=$(cut -d: -f3 /proc/self/cgroup)
  if [ "$self" = "/" ] && [ -f /sys/fs/cgroup/cgroup.subtree_control ]; then
    if [ -n "$(cat /sys/fs/cgroup/cgroup.procs 2>/dev/null)" ]; then
      mkdir -p /sys/fs/cgroup/init
      for p in $(cat /sys/fs/cgroup/cgroup.procs); do echo "$p" > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true; done
    fi
    echo "+cpu +memory +pids +cpuset +io" > /sys/fs/cgroup/cgroup.subtree_control 2>&1 && echo "cg_delegate: controllers enabled: $(cat /sys/fs/cgroup/cgroup.subtree_control)" || echo "cg_delegate: FAILED to enable controllers"
    CGSURR=/sys/fs/cgroup
  else
    CGSURR=/sys/fs/cgroup$self
  fi
  export CGSURR
}
