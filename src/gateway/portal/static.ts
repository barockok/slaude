/**
 * The portal's static mount. The serving itself is the shared implementation in
 * src/gateway/static.ts, which the panel uses too.
 */
import { fileURLToPath } from "node:url";
import { createStaticApp } from "../static";

// The app lives in src/web/portal; its Vite build lands in src/web/portal/dist,
// which createStaticApp prefers when built and falls back from (to the source
// shell) when not.
const app = createStaticApp(fileURLToPath(new URL("../../web/portal", import.meta.url)), "/portal");

export async function servePortalStatic(pathname: string): Promise<Response | null> {
  return app.serve(pathname);
}
