/**
 * The portal's static mount. The serving itself is the shared implementation in
 * src/gateway/static.ts, which the panel uses too.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticApp } from "../static";

const app = createStaticApp(join(fileURLToPath(new URL(".", import.meta.url)), "web"), "/portal");

export async function servePortalStatic(pathname: string): Promise<Response | null> {
  return app.serve(pathname);
}
