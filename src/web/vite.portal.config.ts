import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The personal portal, served by the gateway under /portal. Dev proxies the
// portal's server routes to a running gateway; the same cookie notes as the
// console apply (sign in once on the gateway's origin, then use the dev server).
// /portal/link and /portal/oauth are server-rendered or server-handled pages.
const GATEWAY = process.env.PORTAL_DEV_GATEWAY ?? process.env.PANEL_DEV_GATEWAY ?? "http://localhost:3000";
const proxy = { target: GATEWAY, changeOrigin: true };

export default defineConfig({
  root: fileURLToPath(new URL("./portal", import.meta.url)),
  base: "/portal/",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("./portal/dist", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/portal/api": proxy,
      "/portal/auth": proxy,
      "/portal/oauth": proxy,
      "/portal/link": proxy,
    },
  },
});
