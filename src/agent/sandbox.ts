import { execFileSync } from "node:child_process";
import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";

/** True if a usable OS sandbox backend is present for `claude` to jail bash.
 *  darwin ships `sandbox-exec`; linux needs `bwrap` (bubblewrap) on PATH. */
export function __probeSandbox(
  platform: NodeJS.Platform,
  hasBin: (bin: string) => boolean,
): boolean {
  if (platform === "darwin") return true;
  if (platform === "linux") return hasBin("bwrap");
  return false;
}

function binExists(bin: string): boolean {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let cache: boolean | null = null;

/** Test-only cache reset. */
export function __resetSandboxCache(): void {
  cache = null;
}

/** Cached availability of the OS sandbox on this host. */
export function sandboxAvailable(): boolean {
  if (cache === null) cache = __probeSandbox(process.platform, binExists);
  return cache;
}

/** SandboxSettings for a jailed (non-trusted) session: bash jailed to cwd,
 *  no escape to unsandboxed exec, network egress limited to `allowedDomains`
 *  (empty = none). */
export function jailSandboxOptions(allowedDomains: string[]): SandboxSettings {
  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains },
  };
}
