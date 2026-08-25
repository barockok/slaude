import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The panel app is served by the gateway under /panel, so asset URLs are
// absolute under that base. Dev proxies /panel/api to the running gateway and
// injects the operator header the SSO/ingress would add in prod.
const GATEWAY = process.env.PANEL_DEV_GATEWAY ?? "http://localhost:3000";
const DEV_OPERATOR = process.env.PANEL_DEV_OPERATOR ?? "ops@slaude.dev";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/panel/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/panel/api": {
        target: GATEWAY,
        changeOrigin: true,
        headers: { "x-auth-request-email": DEV_OPERATOR },
      },
    },
  },
});
