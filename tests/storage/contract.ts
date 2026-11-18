import { describe, expect, test } from "bun:test";
import { getBytes, getText, listAll, putText, StorageError, type ObjectStore } from "../../src/storage";

const enc = (s: string) => new TextEncoder().encode(s);

/** One suite, run against every ObjectStore, so all backends behave alike. */
export function runContract(name: string, make: () => Promise<ObjectStore> | ObjectStore): void {
  describe(`ObjectStore contract: ${name}`, () => {
    const ns = () => `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    test("put then get roundtrips bytes, including binary", async () => {
      const s = await make();
      const k = `${ns()}/bin`;
      const bytes = new Uint8Array(256).map((_, i) => i);
      await s.put(k, bytes);
      expect(await getBytes(s, k)).toEqual(bytes);
    });

    test("an empty object roundtrips", async () => {
      const s = await make();
      const k = `${ns()}/empty`;
      await s.put(k, new Uint8Array(0));
      expect((await s.head(k))?.size).toBe(0);
      expect((await getBytes(s, k))?.length).toBe(0);
    });

    test("get of a missing key is null, head too", async () => {
      const s = await make();
      expect(await s.get(`${ns()}/nope`)).toBeNull();
      expect(await s.head(`${ns()}/nope`)).toBeNull();
    });

    test("put overwrites", async () => {
      const s = await make();
      const k = `${ns()}/o`;
      await putText(s, k, "one", "text/plain");
      await putText(s, k, "two!", "text/plain");
      expect(await getText(s, k)).toBe("two!");
      expect((await s.head(k))?.size).toBe(4);
    });

    test("put accepts a stream and a Blob", async () => {
      const s = await make();
      const base = ns();
      await s.put(`${base}/stream`, new Blob([enc("streamed body")]).stream() as ReadableStream<Uint8Array>);
      await s.put(`${base}/blob`, new Blob([enc("blob body")]));
      expect(await getText(s, `${base}/stream`)).toBe("streamed body");
      expect(await getText(s, `${base}/blob`)).toBe("blob body");
    });

    test("a multi-megabyte object roundtrips", async () => {
      const s = await make();
      const k = `${ns()}/big`;
      const big = new Uint8Array(6 * 1024 * 1024).map((_, i) => (i * 31) & 0xff);
      await s.put(k, big);
      expect((await s.head(k))?.size).toBe(big.length);
      const back = await getBytes(s, k);
      expect(back?.length).toBe(big.length);
      expect(Buffer.compare(Buffer.from(back!), Buffer.from(big))).toBe(0);
    });

    test("range get returns the inclusive slice", async () => {
      const s = await make();
      const k = `${ns()}/r`;
      await s.put(k, enc("0123456789"));
      const part = await s.get(k, { range: [2, 5] });
      expect(new TextDecoder().decode(new Uint8Array(await new Response(part!).arrayBuffer()))).toBe("2345");
    });

    test("head reports size and an etag", async () => {
      const s = await make();
      const k = `${ns()}/h`;
      await s.put(k, enc("hello"));
      const h = await s.head(k);
      expect(h?.size).toBe(5);
      expect(typeof h?.etag).toBe("string");
      expect(h!.etag.length).toBeGreaterThan(0);
    });

    test("list is prefix-scoped, ascending, and honors after and limit", async () => {
      const s = await make();
      const base = ns();
      for (const n of ["a", "b", "c", "d"]) await s.put(`${base}/p/${n}`, enc(n));
      await s.put(`${base}/other/x`, enc("x"));
      const all = (await listAll(s, `${base}/p/`)).map((o) => o.key);
      expect(all).toEqual([`${base}/p/a`, `${base}/p/b`, `${base}/p/c`, `${base}/p/d`]);
      const after: string[] = [];
      for await (const o of s.list(`${base}/p/`, { after: `${base}/p/b` })) after.push(o.key);
      expect(after).toEqual([`${base}/p/c`, `${base}/p/d`]);
      const limited: string[] = [];
      for await (const o of s.list(`${base}/p/`, { limit: 2 })) limited.push(o.key);
      expect(limited).toEqual([`${base}/p/a`, `${base}/p/b`]);
    });

    test("list reports each object's size", async () => {
      const s = await make();
      const base = ns();
      await s.put(`${base}/z`, enc("12345"));
      const [o] = await listAll(s, `${base}/`);
      expect(o?.key).toBe(`${base}/z`);
      expect(o?.size).toBe(5);
    });

    test("delete removes many keys and ignores missing ones", async () => {
      const s = await make();
      const base = ns();
      await s.put(`${base}/1`, enc("1"));
      await s.put(`${base}/2`, enc("2"));
      await s.delete([`${base}/1`, `${base}/2`, `${base}/never`]);
      expect(await s.head(`${base}/1`)).toBeNull();
      expect(await s.head(`${base}/2`)).toBeNull();
    });

    test("unsafe keys are refused", async () => {
      const s = await make();
      for (const k of ["/abs", "a/../b", "..", "a\\b", ""]) {
        await expect(s.put(k, enc("x"))).rejects.toBeInstanceOf(StorageError);
      }
    });
  });
}
