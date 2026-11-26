/**
 * `slaude box digests --in-use`: every box image this deployment still
 * references, one `<repository>@sha256:<digest>` per line, for a registry
 * retention job (box spec, "Garbage collection": images in the registry are
 * outside slaude; this is the list of what such a job must keep).
 *
 * Listed:
 *   - every stored version of every box, of every tenant (old versions too: a
 *     session may be pinned to one, and a version row is never deleted while
 *     its box exists);
 *   - every digest a session row is pinned to. The row holds a box name and a
 *     digest, so the repository comes from the box: a stored version with that
 *     digest, or the built-in box's repository for a pin of the built-in;
 *   - the built-in default box's images, every architecture, when this image
 *     carries one.
 *
 * It errs towards keeping: the stored rows are read without their signature
 * check (a row that does not verify is still an image someone may need to
 * inspect), and a closed session's pin counts for as long as its row exists.
 * A pin whose repository cannot be known (its box is gone) is counted, not
 * printed.
 *
 * Runs on the gateway or mono host, with the gateway's database settings. It
 * reads only.
 */
import type { BuiltinBox } from "../box/builtin";
import { BOX_IMAGE_REF_RE, isStandInImage } from "../box/definition";
import type { DbClient } from "../db/client";

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export interface DigestsInUse {
  /** Sorted, unique. */
  images: string[];
  /** Session pins whose repository is not known any more. */
  unresolved: number;
}

export async function digestsInUse(client: DbClient, o: { builtin?: BuiltinBox | null } = {}): Promise<DigestsInUse> {
  const out = new Set<string>();
  const add = (image: string) => {
    if (BOX_IMAGE_REF_RE.test(image) && !isStandInImage(image)) out.add(image);
  };
  const builtin = o.builtin ?? null;
  for (const image of builtin?.images ?? []) add(image);
  let unresolved = 0;
  // Boxes exist on Postgres only; elsewhere there is nothing stored and no session can be pinned.
  if (client.dialect === "pg") {
    const versions = await client.query<{ tenant_id: string; name: string; image: string; digest: string }>(`SELECT tenant_id, name, image, digest FROM box_versions`);
    const repoOf = new Map<string, string>();
    const stored = new Set<string>();
    for (const v of versions) {
      add(v.image);
      stored.add(`${v.tenant_id}\n${v.name}`);
      repoOf.set(`${v.tenant_id}\n${v.name}\n${v.digest}`, v.image);
    }
    const pins = await client.query<{ tenant_id: string; box_name: string; box_digest: string }>(
      `SELECT DISTINCT tenant_id, box_name, box_digest FROM sessions WHERE box_name IS NOT NULL AND box_digest IS NOT NULL`,
    );
    for (const p of pins) {
      const known = repoOf.get(`${p.tenant_id}\n${p.box_name}\n${p.box_digest}`);
      if (known) continue;
      // A pin of the built-in from an earlier release: the same repository, the pinned digest.
      if (builtin && p.box_name === builtin.name && !stored.has(`${p.tenant_id}\n${p.box_name}`) && DIGEST_RE.test(p.box_digest)) {
        add(`${builtin.image.slice(0, builtin.image.indexOf("@"))}@${p.box_digest}`);
        continue;
      }
      unresolved++;
    }
  }
  return { images: [...out].sort(), unresolved };
}
