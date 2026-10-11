/**
 * The panel's static mount. The serving itself is the shared implementation in
 * src/gateway/static.ts, which the portal uses too.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticApp } from "../static";

const app = createStaticApp(join(fileURLToPath(new URL(".", import.meta.url)), "web"), "/panel");

export async function servePanelStatic(pathname: string): Promise<Response | null> {
  return app.serve(pathname);
}
