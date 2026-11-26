/**
 * boxd entry (box spec, "Kubernetes deployment"). Run directly, as root, in
 * the privileged container of a node pod or as a root service on a plain host:
 *
 *   tini -- bun --no-env-file src/box/boxd/main.ts --mount-root /data --mount-root /config-home --ro-root /app
 *
 * Under an init (tini is in the image), never as pid 1 itself: see the warning below.
 *
 *   SLAUDE_BOX_DIR            images, sessions, spool (default /var/lib/slaude-box)
 *   SLAUDE_BOXD_SOCKET        the control socket (default /run/slaude-box/boxd.sock)
 *   SLAUDE_BOX_TIER           gvisor (default) or bwrap: the tier this node offers
 *   SLAUDE_BOXD_MOUNT_ROOTS   colon list, same as repeating --mount-root: directories a box may
 *                             be given read-write (workspaces, config homes, scratch)
 *   SLAUDE_BOXD_RO_ROOTS      colon list, same as --ro-root: directories a box may be given
 *                             read-only only (the node image's CLI and plugins)
 *   SLAUDE_BOX_INIT_DIR       the directory that holds box-init and nothing else
 *                             (default /usr/local/lib/slaude-box)
 *   SLAUDE_BOXD_CLIENT_UID    the node worker's uid when it is not root: it is given the sockets
 *
 * It refuses to start with a credential in its environment, without root,
 * without a working sandbox runtime for its tier, or when it cannot give a
 * sandbox a limited cgroup. None of those is survivable: a supervisor that
 * started anyway would run boxes without limits or next to secrets.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BOX_AGENT_UID } from "../image";
import { boxdRefusedEnv } from "./env-check";
import { createBoxd, delegateCgroup } from "./server";

function fail(message: string): never {
  console.error(`[boxd] refusing to start: ${message}`);
  process.exit(1);
}

function listArg(flag: string, envName: string): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i] === flag && argv[i + 1]) out.push(argv[++i]!);
  for (const p of (process.env[envName] ?? "").split(":")) if (p.trim()) out.push(p.trim());
  return [...new Set(out)];
}

async function main(): Promise<void> {
  // Names only. Nothing else is read from the environment before this.
  const refused = boxdRefusedEnv(process.env);
  if (refused.length) fail(`its environment holds ${refused.length} credential or provider variable(s): ${refused.join(", ")}. The supervisor is privileged and must hold none: give it no envFrom and no Secret.`);
  if (process.platform !== "linux") fail("the box supervisor runs on Linux only");
  if (process.getuid?.() !== 0) fail("it must run as root (it creates cgroups and sandboxes)");
  // bwrap leaves an ended process for pid 1 to reap, and this process does not reap what it did not start. Measured on
  // the bwrap tier: as pid 1 of a container it keeps one zombie per process a box ran, charged to the sandbox's cgroup.
  // runsc's detached sandbox processes are orphans of the same kind (not measured). The image ships tini for this.
  if (process.pid === 1) {
    console.warn("[boxd] running as pid 1: ended sandbox processes will stay as zombies. Start the supervisor under an init: tini -- bun --no-env-file src/box/boxd/main.ts ...");
  }

  const tierRaw = (process.env.SLAUDE_BOX_TIER ?? "gvisor").trim().toLowerCase();
  if (tierRaw !== "gvisor" && tierRaw !== "bwrap") fail("SLAUDE_BOX_TIER must be gvisor or bwrap for the supervisor");
  const tier = tierRaw as "gvisor" | "bwrap";
  const boxDir = (process.env.SLAUDE_BOX_DIR ?? "").trim() || "/var/lib/slaude-box";
  const socketPath = (process.env.SLAUDE_BOXD_SOCKET ?? "").trim() || "/run/slaude-box/boxd.sock";
  const initDir = (process.env.SLAUDE_BOX_INIT_DIR ?? "").trim() || "/usr/local/lib/slaude-box";
  if (!existsSync(join(initDir, "box-init"))) fail(`${join(initDir, "box-init")} does not exist (the compiled box-init; see the Dockerfile)`);
  const clientUidRaw = (process.env.SLAUDE_BOXD_CLIENT_UID ?? "").trim();
  if (clientUidRaw && !/^\d+$/.test(clientUidRaw)) fail("SLAUDE_BOXD_CLIENT_UID is not a number");

  // Before the first sandbox: without this runsc cannot start nested in a container (phase 0 spike).
  const cg = delegateCgroup();
  if (cg) fail(cg);

  const boxd = createBoxd({
    boxDir,
    socketPath,
    mountRoots: listArg("--mount-root", "SLAUDE_BOXD_MOUNT_ROOTS"),
    roRoots: listArg("--ro-root", "SLAUDE_BOXD_RO_ROOTS"),
    initDir,
    agentUid: BOX_AGENT_UID,
    tier,
    ...(clientUidRaw ? { clientUid: Number(clientUidRaw) } : {}),
  });
  const probe = (await boxd.request(0, "probe", {})) as { tiers: Record<string, { ok: boolean; reason?: string; version?: string }> };
  const mine = probe.tiers[tier]!;
  if (!mine.ok) fail(`tier ${tier} cannot run here: ${mine.reason ?? "unknown"}`);
  await boxd.listen();
  console.log(`[boxd] listening on ${socketPath} (tier ${tier}${mine.version ? `, ${mine.version}` : ""}, box directory ${boxDir})`);

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[boxd] ${signal}: stopping every sandbox`);
    void boxd
      .close()
      .catch((e) => console.error("[boxd] stop failed:", e))
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

void main().catch((e) => {
  console.error("[boxd] fatal", e);
  process.exit(1);
});
