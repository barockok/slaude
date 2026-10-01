/** Tiny shared helpers for the /v1 handlers. */

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export const notFound = (what = "not found"): Response => json(404, { error: what });

export const methodNotAllowed = (): Response => json(405, { error: "method not allowed" });

/** Parse a JSON body; empty body → {}. Returns null on malformed JSON. */
export async function readJson(req: Request): Promise<unknown | null> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Buffer a request body under a size cap. A declared Content-Length over the
 * cap is rejected without reading a byte; an absent or lying Content-Length is
 * caught by counting while streaming. Returns null when the cap is exceeded
 * (the caller sends 413).
 */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Abandon the upload without buffering it.
    await req.body?.cancel().catch(() => {});
    return null;
  }
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
