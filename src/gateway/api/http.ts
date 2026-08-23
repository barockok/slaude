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
