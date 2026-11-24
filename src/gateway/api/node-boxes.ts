/**
 * GET /v1/node/boxes: the box images a node should hold (box spec, "Image
 * build, pull and prewarm", "What a node pulls").
 *
 * Node-authenticated. There is no job token at node start, so the label gate
 * is applied here, on the caller's own verified labels: the answer lists only
 * boxes of personas that run on a label the node's credential carries. For
 * each such box it gives the current version's image, and every digest a
 * recently active session is pinned to, so a node can serve a pinned session
 * without a pull at its first turn.
 *
 * The answer holds image references and digests only: no policy, no persona
 * name, no session id. With SLAUDE_BOX off it is the empty list and nothing
 * is read. A box set that does not verify is an error (503), never a shorter
 * list: a node that prewarmed from a set that cannot be trusted would be
 * holding images nobody reviewed.
 */
import type { NodeIdentity } from "./auth";
import { json } from "./http";
import { env } from "../../config/env";
import { db } from "../../db/client";
import { getPersonaRegistry, managedPersonaDefinition, runsOnFor } from "../../persona/registry";
import { boxSnapshot, type BoxSnapshot } from "../core/box-registry";

/** How far back a pinned session counts as one a node may be asked to resume. */
export const PINNED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PINNED = 2000;
const TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/;

export interface NodeBox {
  name: string;
  /** `<repository>@sha256:<digest>`. */
  image: string;
  /** `sha256:<digest>`. */
  digest: string;
  /** True for the box's current version; false for an older image a session is still pinned to. */
  current: boolean;
}

export interface NodeBoxesDeps {
  enabled?: () => boolean;
  /** Every live persona with the label it runs on and the box it names (null: none). */
  personas?: () => Array<{ label: string; box: string | null }>;
  snapshot?: (tenant: string) => Promise<BoxSnapshot>;
  /** (box name, digest) of sessions pinned and active since `since`. */
  pinned?: (since: number) => Promise<Array<{ name: string; digest: string }>>;
  now?: () => number;
}

function defaultPersonas(): Array<{ label: string; box: string | null }> {
  const r = getPersonaRegistry();
  const dflt = env.box.defaultBox();
  const names = ["default", ...r.list().map((p) => p.name)];
  return names.map((n) => ({ label: runsOnFor(n, r), box: managedPersonaDefinition(n, r)?.box ?? dflt }));
}

async function defaultPinned(since: number): Promise<Array<{ name: string; digest: string }>> {
  const rows = await db.query<{ box_name: string; box_digest: string }>(
    `SELECT DISTINCT box_name, box_digest FROM sessions WHERE box_digest IS NOT NULL AND box_name IS NOT NULL AND updated_at >= ? LIMIT ${MAX_PINNED}`,
    [since],
  );
  return rows.map((r) => ({ name: r.box_name, digest: r.box_digest }));
}

/** The list for a set of labels. Exported for tests and for the console's view. */
export async function boxesForLabels(labels: ReadonlySet<string>, tenant: string, deps: NodeBoxesDeps = {}): Promise<{ setVersion: number; boxes: NodeBox[] }> {
  const wanted = new Set((deps.personas ?? defaultPersonas)().filter((p) => p.box && labels.has(p.label)).map((p) => p.box!));
  if (wanted.size === 0) return { setVersion: 0, boxes: [] };
  const snap = await (deps.snapshot ?? boxSnapshot)(tenant);
  const out = new Map<string, NodeBox>();
  for (const name of [...wanted].sort()) {
    const cur = snap.boxes.get(name)?.current;
    if (cur) out.set(`${name}\n${cur.digest}`, { name, image: cur.image, digest: cur.digest, current: true });
  }
  const now = (deps.now ?? Date.now)();
  for (const p of await (deps.pinned ?? defaultPinned)(now - PINNED_WINDOW_MS)) {
    if (!wanted.has(p.name) || out.has(`${p.name}\n${p.digest}`)) continue;
    // The newest version that has this digest names the repository it lives in. A digest the set no longer has is not listed.
    const at = [...(snap.boxes.get(p.name)?.versions ?? [])].reverse().find((v) => v.digest === p.digest);
    if (at) out.set(`${p.name}\n${p.digest}`, { name: p.name, image: at.image, digest: at.digest, current: false });
  }
  return { setVersion: snap.setVersion, boxes: [...out.values()] };
}

export async function handleNodeBoxes(req: Request, node: NodeIdentity, deps: NodeBoxesDeps = {}): Promise<Response> {
  if (!(deps.enabled ?? (() => env.box.enabled()))()) return json(200, { setVersion: 0, boxes: [] });
  const tenant = new URL(req.url).searchParams.get("tenant") ?? "default";
  if (!TENANT_RE.test(tenant)) return json(400, { error: "invalid tenant" });
  try {
    return json(200, await boxesForLabels(node.labels, tenant, deps));
  } catch (e) {
    console.error(`[v1] node boxes unavailable node=${node.id} tenant=${tenant}: ${e instanceof Error ? e.message : String(e)}`);
    return json(503, { error: "box set unavailable", code: "BOX_UNAVAILABLE", transient: false });
  }
}
