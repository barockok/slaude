/**
 * Static asset serving for a built web app mounted under a path prefix. Both the
 * operator panel (`/panel`) and the end-user portal (`/portal`) use one
 * implementation, parameterised by root and prefix, so a traversal guard or a
 * caching rule fixed for one is fixed for both.
 *
 * SPA-style: a path with no file extension that misses falls back to index.html,
 * so client routing works. A path that resolves outside the root is refused.
 *
 * Deliberately tiny — no framework. Bun's `Bun.file` handles content types and
 * streaming; a missing file yields null and the caller surfaces a 404.
 */
import { join, normalize } from "node:path";

export interface StaticApp {
  serve(pathname: string): Promise<Response | null>;
}

/**
 * @param webDir  the app's source directory; its `dist/` is preferred when built
 * @param prefix  the mount path, without a trailing slash (e.g. "/portal")
 */
export function createStaticApp(webDir: string, prefix: string): StaticApp {
  const distRoot = join(webDir, "dist");
  let rootCache: string | null = null;

  // Resolved once: whether the app was built decides the root for the process's
  // life, and re-checking per request would stat on every asset.
  async function root(): Promise<string> {
    if (rootCache) return rootCache;
    rootCache = (await Bun.file(join(distRoot, "index.html")).exists()) ? distRoot : webDir;
    return rootCache;
  }

  const stripPrefix = (pathname: string) =>
    pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length + 1) : pathname === prefix ? "" : pathname;

  /** Map a request path to a file under the root, or null when it escapes. */
  function resolveAsset(rootDir: string, pathname: string): string | null {
    let rel = stripPrefix(pathname);
    if (rel === "" || rel.endsWith("/")) rel = `${rel}index.html`;
    const full = normalize(join(rootDir, rel));
    if (full !== rootDir && !full.startsWith(rootDir + "/")) return null;
    return full;
  }

  async function serve(pathname: string): Promise<Response | null> {
    const rootDir = await root();
    const full = resolveAsset(rootDir, pathname);
    if (full === null) return new Response("forbidden", { status: 403 });

    // Hashed build assets are immutable; the HTML shell must not be cached, or a
    // deploy leaves browsers loading assets that no longer exist.
    const isAsset = /\/assets\/.+\.[a-z0-9]+$/i.test(pathname);
    const cache = isAsset ? "public, max-age=31536000, immutable" : "no-cache";

    const file = Bun.file(full);
    if (await file.exists()) return new Response(file, { headers: { "cache-control": cache } });

    // SPA fallback for extension-less client routes.
    if (!/\.[a-z0-9]+$/i.test(stripPrefix(pathname))) {
      const index = Bun.file(join(rootDir, "index.html"));
      if (await index.exists()) return new Response(index, { headers: { "cache-control": "no-cache" } });
    }
    return null;
  }

  return { serve };
}
