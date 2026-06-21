// CLI entrypoint for `slaude brain-server`. Thin process bootstrap: read config,
// boot the engine, serve. Exercised by smoke runs, not unit tests — excluded from
// coverage in codecov.yml. Keep logic-free; testable pieces live in brain-server.ts.

import { brainServerConfig } from "../brain-config";
import { startBrainServer } from "./brain-server";

const cfg = brainServerConfig();
startBrainServer(cfg, undefined, { boot: true })
  .then((s) => {
    console.log(`[brain-server] listening on ${cfg.host}:${s.port} (mcp /mcp)`);
    if (cfg.authDisabled) console.warn("[brain-server] OAuth DISABLED (SLAUDE_BRAIN_AUTH_DISABLED=1)");
    else console.log(`[brain-server] OAuth issuer=${cfg.issuer ?? "(unset!)"} audience=${cfg.audience ?? "(unset!)"}`);
  })
  .catch((e) => {
    console.error("[brain-server] failed to start:", e);
    process.exit(1);
  });
