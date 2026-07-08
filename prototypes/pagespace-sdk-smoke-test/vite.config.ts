import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The PageSpace API sends no Access-Control-Allow-Origin header (verified:
// neither the real response nor its OPTIONS preflight carry any CORS
// headers), so a browser's own fetch() to https://pagespace.ai is always
// blocked, independent of any SDK code. This dev-only proxy makes the
// browser's request same-origin (http://localhost:5183/api/... ->
// forwarded server-side, in Vite's Node process, to the real API) — CORS
// is a browser enforcement mechanism, so it never applies to the proxy's
// own outbound request. Demo/dev workaround only; not a fix for real
// third-party browser apps built directly on @pagespace/sdk.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "https://pagespace.ai",
        changeOrigin: true,
      },
    },
  },
});
