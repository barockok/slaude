/**
 * The panel's static mount. The serving itself is the shared implementation in
 * src/gateway/static.ts, which the portal uses too.
 */
import { fileURLToPath } from "node:url";
import { createStaticApp } from "../static";

// The app lives in src/web/console; its Vite build lands in src/web/console/dist,
// which createStaticApp prefers when built and falls back from (to the source
// shell) when not.
const app = createStaticApp(fileURLToPath(new URL("../../web/console", import.meta.url)), "/panel");

export async function servePanelStatic(pathname: string): Promise<Response | null> {
  return app.serve(pathname);
}
