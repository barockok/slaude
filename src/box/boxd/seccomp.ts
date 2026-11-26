/**
 * The seccomp filter of the bwrap tier, as a classic BPF program bwrap loads
 * with `--seccomp`.
 *
 * It is a deny list, and deliberately a short one. A bwrap box already has no
 * capability, so most of these calls would fail anyway; the filter removes
 * them from the kernel's reachable surface instead of relying on that. What
 * it refuses: mounting and the new mount API, entering or creating
 * namespaces, kernel modules and kexec, keyrings, bpf, perf, io_uring, the
 * clock, swap, reboot, handle-based opens, and reading or writing another
 * process's memory. Everything else is allowed: a development toolchain uses
 * far too many calls for an allow list to be maintained here.
 *
 * A refused call fails with EPERM. A process of another architecture than the
 * one the filter was built for (a 32 bit binary on a 64 bit kernel) is ended:
 * its call numbers would mean something else.
 *
 * gVisor needs none of this: its sandbox does not pass system calls to the
 * host kernel at all.
 */

const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;

const RET_KILL_PROCESS = 0x80000000;
const RET_ALLOW = 0x7fff0000;
const RET_ERRNO_EPERM = 0x00050000 | 1;

/** System call numbers refused, by architecture. The names are the kernel's. */
export const DENIED_SYSCALLS: Readonly<Record<"x64" | "arm64", Readonly<Record<string, number>>>> = {
  arm64: {
    umount2: 39, mount: 40, pivot_root: 41, quotactl: 60, acct: 89, unshare: 97, kexec_load: 104, init_module: 105, delete_module: 106,
    clock_settime: 112, reboot: 142, sethostname: 161, setdomainname: 162, settimeofday: 170, adjtimex: 171, add_key: 217, request_key: 218,
    keyctl: 219, swapon: 224, swapoff: 225, perf_event_open: 241, name_to_handle_at: 264, open_by_handle_at: 265, clock_adjtime: 266,
    setns: 268, process_vm_readv: 270, process_vm_writev: 271, finit_module: 273, bpf: 280, userfaultfd: 282, kexec_file_load: 294,
    io_uring_setup: 425, io_uring_enter: 426, io_uring_register: 427, open_tree: 428, move_mount: 429, fsopen: 430, fsconfig: 431,
    fsmount: 432, fspick: 433, mount_setattr: 442,
  },
  x64: {
    uselib: 134, vhangup: 153, pivot_root: 155, _sysctl: 156, adjtimex: 159, acct: 163, settimeofday: 164, mount: 165, umount2: 166,
    swapon: 167, swapoff: 168, reboot: 169, sethostname: 170, setdomainname: 171, iopl: 172, ioperm: 173, create_module: 174,
    init_module: 175, delete_module: 176, quotactl: 179, nfsservctl: 180, clock_settime: 227, kexec_load: 246, add_key: 248,
    request_key: 249, keyctl: 250, unshare: 272, perf_event_open: 298, name_to_handle_at: 303, open_by_handle_at: 304, clock_adjtime: 305,
    setns: 308, process_vm_readv: 310, process_vm_writev: 311, finit_module: 313, kexec_file_load: 320, bpf: 321, userfaultfd: 323,
    io_uring_setup: 425, io_uring_enter: 426, io_uring_register: 427, open_tree: 428, move_mount: 429, fsopen: 430, fsconfig: 431,
    fsmount: 432, fspick: 433, mount_setattr: 442,
  },
};

// Classic BPF opcodes.
const LD_W_ABS = 0x20;
const JEQ_K = 0x15;
const JGE_K = 0x35;
const RET_K = 0x06;

type Insn = [code: number, jt: number, jf: number, k: number];

/** The instructions of the filter. Exported so a test can run them. */
export function seccompInstructions(arch: string): Insn[] {
  const key = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
  if (!key) throw new Error(`no seccomp filter for architecture ${arch}`);
  const denied = [...new Set(Object.values(DENIED_SYSCALLS[key]))].sort((a, b) => a - b);
  const n = denied.length;
  const out: Insn[] = [
    [LD_W_ABS, 0, 0, 4], // seccomp_data.arch
    [JEQ_K, 1, 0, key === "x64" ? AUDIT_ARCH_X86_64 : AUDIT_ARCH_AARCH64],
    [RET_K, 0, 0, RET_KILL_PROCESS],
    [LD_W_ABS, 0, 0, 0], // seccomp_data.nr
  ];
  // The x32 ABI shares the x86-64 audit architecture and numbers its calls from 0x40000000: refuse all of it.
  if (key === "x64") out.push([JGE_K, n + 1, 0, 0x40000000]);
  denied.forEach((nr, i) => out.push([JEQ_K, n - i, 0, nr]));
  out.push([RET_K, 0, 0, RET_ALLOW]);
  out.push([RET_K, 0, 0, RET_ERRNO_EPERM]);
  return out;
}

/** The filter as the bytes bwrap reads: an array of `struct sock_filter`, little endian. */
export function seccompProgram(arch: string): Uint8Array {
  const insns = seccompInstructions(arch);
  const buf = Buffer.alloc(insns.length * 8);
  insns.forEach(([code, jt, jf, k], i) => {
    buf.writeUInt16LE(code, i * 8);
    buf.writeUInt8(jt, i * 8 + 2);
    buf.writeUInt8(jf, i * 8 + 3);
    buf.writeUInt32LE(k >>> 0, i * 8 + 4);
  });
  return buf;
}

/** Run the filter on one call, as the kernel would. For tests. */
export function seccompVerdict(arch: string, callArch: number, nr: number): "allow" | "eperm" | "kill" {
  const insns = seccompInstructions(arch);
  let acc = 0;
  for (let pc = 0; pc < insns.length; pc++) {
    const [code, jt, jf, k] = insns[pc]!;
    if (code === LD_W_ABS) acc = k === 4 ? callArch >>> 0 : nr >>> 0;
    else if (code === JEQ_K) pc += acc === k >>> 0 ? jt : jf;
    else if (code === JGE_K) pc += acc >= k >>> 0 ? jt : jf;
    else if (code === RET_K) return k >>> 0 === RET_ALLOW ? "allow" : k >>> 0 === RET_KILL_PROCESS ? "kill" : "eperm";
  }
  return "kill";
}

export const SECCOMP_AUDIT_ARCH = { x64: AUDIT_ARCH_X86_64, arm64: AUDIT_ARCH_AARCH64 } as const;
