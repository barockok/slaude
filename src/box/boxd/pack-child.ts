/**
 * One pack request of the box supervisor, in its own process (see
 * `childPackRunner` in ./server.ts for why). It reads one JSON line, does the
 * work with the packer of ./pack.ts, and answers with one JSON line.
 *
 *   {"op":"pack","unit":{...},"req":{...},"owner":{...},"spoolDir":"..."}
 *     -> {"ok":true,"layer":null}                       nothing changed
 *     -> {"ok":true,"layer":{path,hash,bytes,...}}      then it WAITS for
 *        {"op":"commit","id":"..."} or {"op":"dispose"}  and answers {"ok":true}
 *   {"op":"apply","unit":{...},"req":{id,layers},"owner":{...},"spoolDir":"..."}
 *     -> {"ok":true,"liveBytes":n}
 *   {"op":"clear","unit":{...},"spoolDir":"..."}
 *     -> {"ok":true}
 *
 * A failure is {"ok":false,"error":{name,message,data}}. Every path was checked
 * by the supervisor before this process was started. It reads no environment
 * and holds no credential.
 */
import { createInterface } from "node:readline";
import { PackQuotaError, type PackRequest, type PackUnitRef, type PackedLayer, type AppliedLayer } from "../../storage/pack-sync";
import { localPacker } from "./pack";

/** The last answer's write: the process leaves only once it has been handed to the pipe. */
let written: Promise<void> = Promise.resolve();
const say = (v: unknown): void => {
  written = new Promise<void>((resolve) => void process.stdout.write(`${JSON.stringify(v)}\n`, () => resolve()));
};

function failure(e: unknown): { ok: false; error: { name: string; message: string; data?: unknown } } {
  const err = e instanceof Error ? e : new Error(String(e));
  const data = e instanceof PackQuotaError ? { liveBytes: e.liveBytes, maxBytes: e.maxBytes } : undefined;
  return { ok: false, error: { name: err.name, message: err.message, ...(data ? { data } : {}) } };
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done) return;
  let layer: PackedLayer | null = null;
  try {
    const m = JSON.parse(first.value) as { op: string; unit: PackUnitRef; req?: unknown; owner?: { uid: number; gid: number }; spoolDir: string };
    const packer = localPacker({ spoolDir: m.spoolDir, ...(m.owner ? { owner: m.owner } : {}) });
    if (m.op === "apply") {
      const r = await packer.apply(m.unit, m.req as { id: string; layers: AppliedLayer[] });
      return say({ ok: true, ...(r && typeof r.liveBytes === "number" ? { liveBytes: r.liveBytes } : {}) });
    }
    if (m.op === "clear") {
      await packer.clear(m.unit);
      return say({ ok: true });
    }
    if (m.op !== "pack") throw new Error("unknown pack operation");
    layer = await packer.pack(m.unit, m.req as PackRequest);
    if (!layer) return say({ ok: true, layer: null });
    const { commit: _c, dispose: _d, ...plain } = layer;
    say({ ok: true, layer: plain });
  } catch (e) {
    return say(failure(e));
  }
  // The index built by the scan lives in this process: it is written when the manifest that holds the layer exists.
  const second = await lines.next();
  try {
    const m = second.done ? { op: "dispose" } : (JSON.parse(second.value) as { op: string; id?: string });
    if (m.op === "commit" && typeof m.id === "string") await layer.commit(m.id);
    await layer.dispose();
    say({ ok: true });
  } catch (e) {
    try {
      await layer.dispose();
    } catch {
      /* the spool file is swept with the spool */
    }
    say(failure(e));
  }
}

void main()
  .catch((e) => say(failure(e)))
  .finally(() => written.then(() => process.exit(0)));
