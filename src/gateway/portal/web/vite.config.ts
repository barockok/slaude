import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The portal app is served by the gateway under /portal, so asset URLs are
// absolute under that base.
//
// Dev proxies /portal/api, /portal/auth and /portal/oauth to a running gateway.
// Identity rides on the portal's HttpOnly session cookie, which is host-scoped
// and port-blind, so the usable dev flow mirrors the panel's: sign in once at
// http://localhost:3000/portal, then run `bun run portal:dev`.
const GATEWAY = process.env.PORTAL_DEV_GATEWAY ?? "http://localhost:3000";
const proxy = { target: GATEWAY, changeOrigin: true };

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/portal/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/portal/api": proxy,
      "/portal/auth": proxy,
      "/portal/oauth": proxy,
    },
  },
});
