/**
 * Static asset serving for the panel web app (design §2). Serves the built
 * React app (or today's placeholder) from `src/gateway/panel/web/` under
 * `/panel`. SPA-style: unknown non-API paths fall back to index.html so client
 * routing works. Path traversal outside the web root is refused.
 *
 * Deliberately tiny — no framework. Bun's `Bun.file` handles content types and
 * streaming; a missing file yields a 404 the caller surfaces.
 */
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "web");
// The Vite build emits to web/dist; prefer it when present, fall back to the
// web dir itself (dev placeholder / unbuilt tree).
const DIST_ROOT = join(WEB_DIR, "dist");
let webRootCache: string | null = null;
async function webRoot(): Promise<string> {
  if (webRootCache) return webRootCache;
  webRootCache = (await Bun.file(join(DIST_ROOT, "index.html")).exists()) ? DIST_ROOT : WEB_DIR;
  return webRootCache;
}

/** Map a `/panel` request path to a file under the web root. Returns null when
 *  the resolved path escapes the root (traversal attempt). */
function resolveAsset(root: string, pathname: string): string | null {
  // Strip the /panel prefix; "" or "/" → index.html.
  let rel = pathname.replace(/^\/panel\/?/, "");
  if (rel === "" || rel.endsWith("/")) rel = `${rel}index.html`;
  const full = normalize(join(root, rel));
  if (full !== root && !full.startsWith(root + "/")) return null;
  return full;
}

/**
 * Serve a static panel asset for a non-API `/panel` path. Returns the Response,
 * or null when nothing matched (caller can 404). SPA fallback: a path with no
 * file extension that misses falls back to index.html.
 */
export async function servePanelStatic(pathname: string): Promise<Response | null> {
  const root = await webRoot();
  const full = resolveAsset(root, pathname);
  if (full === null) return new Response("forbidden", { status: 403 });

  // Hashed build assets are immutable; the HTML shell must not be cached.
  const isAsset = /\/assets\/.+\.[a-z0-9]+$/i.test(pathname);
  const cache = isAsset ? "public, max-age=31536000, immutable" : "no-cache";

  const file = Bun.file(full);
  if (await file.exists()) {
    return new Response(file, { headers: { "cache-control": cache } });
  }

  // SPA fallback for extension-less client routes.
  const hasExt = /\.[a-z0-9]+$/i.test(pathname.replace(/^\/panel\/?/, ""));
  if (!hasExt) {
    const index = Bun.file(join(root, "index.html"));
    if (await index.exists()) {
      return new Response(index, { headers: { "cache-control": "no-cache" } });
    }
  }
  return null;
}
