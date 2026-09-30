import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import type { SocketFactory } from "./conn";
import { isTailcatAddr } from "./shell";

/** `tailcat <addr> 22` as a byte pipe: its stdio is the SSH socket. */
export function tailcatSocket(addr: string, bin = "tailcat"): SocketFactory {
  if (!isTailcatAddr(addr)) throw new Error("invalid tailcat address");
  return () => {
    const p = spawn(bin, [addr, "22"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
    // tailcat logs progress lines ("# Selected ...") on stderr: drop them; they include the address.
    p.stderr.on("data", () => {});
    const d = Duplex.from({ readable: p.stdout, writable: p.stdin });
    d.on("close", () => p.kill());
    p.on("exit", () => d.destroy());
    return d;
  };
}

/** Path to the remote as tailcat sees it: a direct UDP path, a DERP relay, or nothing. */
export async function tailcatPing(addr: string, bin = "tailcat"): Promise<"direct" | "relayed" | "unreachable"> {
  if (!isTailcatAddr(addr)) return "unreachable";
  const p = Bun.spawn([bin, "ping", "--timeout=5s", addr], { stdout: "pipe", stderr: "pipe" });
  const text = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  await p.exited;
  if (!/pong/i.test(text)) return "unreachable";
  return /via DERP/i.test(text) ? "relayed" : "direct";
}
