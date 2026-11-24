/**
 * The console's read-only Boxes view: every box of the tenant with its
 * versions, digests and policy. Nothing here writes; a box changes only
 * through the deploy repository.
 *
 * The response is built field by field from the verified set, never by
 * passing a stored object through: a field added to the store later is not
 * shown until it is added here on purpose. A box holds no secret, but an
 * `env` value and a stdio server's arguments are operator-written text, so the
 * view lists their names and counts and leaves the values out.
 */
import type { BoxPolicy } from "../../box/policy";
import { BoxIntegrityError, loadBoxes, type BoxSnapshot, type BoxVersion } from "../core/box-registry";
import type { BoxPolicyView, BoxVersionView, BoxesResponse } from "./api-types";

function policyView(p: BoxPolicy): BoxPolicyView {
  return {
    tier: p.tier,
    resources: {
      cpu: p.resources.cpu,
      memoryMb: p.resources.memoryMb,
      memoryReserveMb: p.resources.memoryReserveMb,
      pids: p.resources.pids,
      homeMb: p.resources.homeMb,
      workspaceExtrasMb: p.resources.workspaceExtrasMb,
      rootOverlayMb: p.resources.rootOverlayMb,
    },
    egress: { allow: [...p.egress.allow], deny: [...p.egress.deny] },
    env: Object.keys(p.env).sort(),
    stdio: Object.entries(p.mcp.stdio)
      .map(([name, s]) => ({ name, command: s.command, args: s.args.length }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    durableExclude: [...p.durable.exclude],
    refresh: { force: p.refresh.force, note: p.refresh.note },
  };
}

/** The repository of an image reference, without its digest. */
const repositoryOf = (image: string) => image.slice(0, image.indexOf("@"));

function versionView(v: BoxVersion, current: number): BoxVersionView {
  return { version: v.version, current: v.version === current, repository: repositoryOf(v.image), digest: v.digest, forced: v.forced, tier: v.policy.tier };
}

/** `enabled` is the gateway's SLAUDE_BOX switch: off, boxes are stored and nothing applies them. */
export async function boxesView(
  tenant: string,
  o: { enabled: boolean; load?: (tenant: string) => Promise<BoxSnapshot> },
): Promise<BoxesResponse> {
  let snap: BoxSnapshot;
  try {
    snap = await (o.load ?? loadBoxes)(tenant);
  } catch (e) {
    if (!(e instanceof BoxIntegrityError)) throw e;
    // The reason names boxes, never content. Nothing of an unverified set is shown.
    return { enabled: o.enabled, verified: false, problem: e.reason, setVersion: null, boxes: [] };
  }
  const boxes = [...snap.boxes.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((b) => ({
      name: b.name,
      description: b.description,
      version: b.current.version,
      repository: repositoryOf(b.current.image),
      digest: b.current.digest,
      policy: policyView(b.current.policy),
      // Newest first.
      versions: [...b.versions].reverse().map((v) => versionView(v, b.current.version)),
    }));
  return { enabled: o.enabled, verified: true, setVersion: snap.setVersion, boxes };
}
