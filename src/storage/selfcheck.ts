import { StorageError, type ObjectStore } from "./object-store";
import { m } from "../metrics";

/**
 * Put, head, get, list and delete one probe object. A provider that is only
 * half S3-compatible fails here at boot, naming the operation, instead of in
 * the middle of a turn.
 */
export async function storageSelfCheck(store: ObjectStore, id: string): Promise<void> {
  const key = `_probe/${id.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  const body = new TextEncoder().encode(`slaude-probe-${Date.now()}`);
  const fail = (op: StorageError["op"], what: string): never => {
    m.storageSelfcheckOk.set(0);
    throw new StorageError(op, `self-check failed: ${what}`);
  };
  try {
    await store.put(key, body);
  } catch (e) {
    return fail("put", e instanceof Error ? e.message : String(e));
  }
  const h = await store.head(key).catch((e) => fail("head", e instanceof Error ? e.message : String(e)));
  if (!h || h.size !== body.length) fail("head", `expected ${body.length} bytes, got ${h ? h.size : "no object"}`);
  const s = await store.get(key).catch((e) => fail("get", e instanceof Error ? e.message : String(e)));
  if (!s) return fail("get", "the object just written was not found");
  const back = new Uint8Array(await new Response(s).arrayBuffer());
  if (back.length !== body.length || back.some((b, i) => b !== body[i])) fail("get", "the object read back differs from what was written");
  let found = false;
  try {
    for await (const o of store.list("_probe/")) if (o.key === key) found = true;
  } catch (e) {
    return fail("list", e instanceof Error ? e.message : String(e));
  }
  if (!found) fail("list", "the object just written is not listed");
  try {
    await store.delete([key]);
  } catch (e) {
    return fail("delete", e instanceof Error ? e.message : String(e));
  }
  if (await store.head(key).catch(() => null)) fail("delete", "the object is still there after delete");
  m.storageSelfcheckOk.set(1);
}
