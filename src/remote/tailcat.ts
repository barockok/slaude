import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import type { SocketFactory } from "./conn";
import { isTailcatAddr } from "./shell";

/** The tailcat binary: SLAUDE_TAILCAT_BIN (read at call time, for tests/odd installs) or "tailcat" on PATH. */
const tailcatBin = (): string => process.env.SLAUDE_TAILCAT_BIN || "tailcat";

/** `tailcat <addr> 22` as a byte pipe: its stdio is the SSH socket. */
export function tailcatSocket(addr: string, bin = tailcatBin()): SocketFactory {
  if (!isTailcatAddr(addr)) throw new Error("invalid tailcat address");
  return () => {
    const p = spawn(bin, [addr, "22"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
    // tailcat logs progress lines ("# Selected ...") on stderr: drop them; they include the address.
    p.stderr.on("data", () => {});
    // A hand-rolled Duplex: Duplex.from() over the child's pipes does not reliably
    // emit 'error'/'close' when destroyed, and ssh2 only notices a dead transport through them.
    const d = new Duplex({
      read() { p.stdout!.resume(); },
      write(chunk, _enc, cb) { p.stdin!.write(chunk, cb); },
      final(cb) { p.stdin!.end(cb); },
      destroy(err, cb) { p.kill(); cb(err); },
    });
    // The error can land before the SSH client has attached its own listener.
    d.on("error", () => {});
    p.stdout!.on("data", (c) => { if (!d.push(c)) p.stdout!.pause(); });
    p.stdout!.on("end", () => d.push(null));
    // Bun also surfaces a failed spawn on the child's pipes.
    p.stdin!.on("error", () => {});
    p.stdout!.on("error", (e) => d.destroy(e));
    p.stderr!.on("error", () => {});
    // A missing binary (ENOENT) is an async 'error' on the child; without a listener it crashes the process.
    p.on("error", (e) => d.destroy(e));
    p.on("close", () => d.destroy());
    return d;
  };
}

/** Path to the remote as tailcat sees it: a direct UDP path, a DERP relay, or nothing. */
export async function tailcatPing(addr: string, bin = tailcatBin()): Promise<"direct" | "relayed" | "unreachable"> {
  if (!isTailcatAddr(addr)) return "unreachable";
  try {
    const p = Bun.spawn([bin, "ping", "--timeout=5s", addr], { stdout: "pipe", stderr: "pipe" });
    const text = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    await p.exited;
    if (!/pong/i.test(text)) return "unreachable";
    return /via DERP/i.test(text) ? "relayed" : "direct";
  } catch {
    return "unreachable"; // missing binary or spawn failure
  }
}
