import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The panel app is served by the gateway under /panel, so asset URLs are
// absolute under that base.
//
// Dev proxies both /panel/api and /panel/auth to a running gateway. There is no
// operator header to inject any more: the panel is its own OIDC relying party
// and identity rides on its HttpOnly session cookie. Those cookies are
// host-scoped and port-blind, so the usable dev flow is:
//
//   1. run the gateway (`bun run dev`) and sign in once at
//      http://localhost:3000/panel;
//   2. run `bun run panel:dev` — the browser sends the same localhost cookies
//      to the Vite origin, and the proxy forwards them upstream.
//
// Hitting /panel/auth/login from the Vite origin also works, but the provider
// redirects back to the gateway's registered redirect_uri, so you land on the
// gateway's own copy of the panel rather than the dev server. Sign in there
// first and reload the dev server.
const GATEWAY = process.env.PANEL_DEV_GATEWAY ?? "http://localhost:3000";
const proxy = { target: GATEWAY, changeOrigin: true };

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
      "/panel/api": proxy,
      "/panel/auth": proxy,
    },
  },
});
