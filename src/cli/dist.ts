// src/cli/dist.ts
import { readdirSync, lstatSync, readlinkSync, statSync, symlinkSync, renameSync, rmSync as fsRm } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const REPO = "barockok/slaude";

const SEMVER = /^\d+\.\d+\.\d+$/;

export function distPaths(env: { SLAUDE_DIST?: string; SLAUDE_BIN_DIR?: string; HOME?: string } = process.env as { SLAUDE_DIST?: string; SLAUDE_BIN_DIR?: string; HOME?: string }) {
  const home = env.HOME ?? "";
  const root = env.SLAUDE_DIST?.trim() || join(home, ".slaude-dist");
  const binDir = env.SLAUDE_BIN_DIR?.trim() || join(home, ".local", "bin");
  return { root, current: join(root, "current"), binLink: join(binDir, "slaude") };
}

function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  return 0;
}

export function installedVersions(root: string): string[] {
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  return names
    .filter((n) => SEMVER.test(n) && safeIsDir(join(root, n)))
    .sort(cmpSemver);
}

function safeIsDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export function currentVersion(root: string): string | null {
  try {
    const link = join(root, "current");
    if (!lstatSync(link).isSymbolicLink()) return null;
    const target = readlinkSync(link).replace(/\/+$/, "");
    const v = target.split("/").pop() ?? "";
    return SEMVER.test(v) ? v : null;
  } catch { return null; }
}

export function previousVersion(root: string): string | null {
  const cur = currentVersion(root);
  const others = installedVersions(root).filter((v) => v !== cur);
  return others.length ? others[others.length - 1]! : null;
}

export type FetchLike = typeof fetch;

export async function resolveLatestVersion(fetchImpl: FetchLike = fetch): Promise<string> {
  const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "slaude-cli" },
  } as any);
  if (!(res as any).ok) throw new Error("could not resolve latest release");
  const body: any = await (res as any).json();
  const tag: string | undefined = body?.tag_name;
  if (!tag) throw new Error("could not resolve latest release: no tag_name");
  return tag.replace(/^v/, "");
}

export function verifyChecksum(bytes: Uint8Array, sumsText: string, filename: string): boolean {
  const got = createHash("sha256").update(bytes).digest("hex").toLowerCase();
  for (const raw of sumsText.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // shasum / sha256sum format: "<64-hex>  <name>" (text) or "<64-hex> *<name>" (binary).
    const m = line.match(/^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/);
    if (!m) continue;
    if (m[2] === filename) return m[1]!.toLowerCase() === got;
  }
  return false;
}

export function swapCurrent(root: string, version: string): void {
  const tmp = join(root, `.current.tmp.${process.pid}.${version}`);
  try { fsRm(tmp, { force: true }); } catch {}
  symlinkSync(version, tmp);            // relative target — survives a moved root
  renameSync(tmp, join(root, "current")); // atomic replace
}

export function pruneVersions(root: string, keep: number): string[] {
  const cur = currentVersion(root);
  const all = installedVersions(root);                 // ascending semver
  const keepSet = new Set(all.slice(Math.max(0, all.length - keep))); // newest `keep` total
  if (cur) keepSet.add(cur);                            // never remove the active version
  const removed = all.filter((v) => !keepSet.has(v));
  for (const v of removed) fsRm(join(root, v), { recursive: true, force: true });
  return removed;
}
