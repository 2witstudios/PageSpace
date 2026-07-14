import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The PageSpace API sends no Access-Control-Allow-Origin header, so a
// browser's own fetch() to https://pagespace.ai is always blocked,
// independent of any SDK code. This dev-only proxy makes the browser's
// request same-origin (http://localhost:5184/api/... -> forwarded
// server-side, in Vite's Node process, to the real API) — CORS is a
// browser enforcement mechanism, so it never applies to the proxy's own
// outbound request. Demo/dev workaround only; a real deployed SPA needs
// either a same-origin reverse proxy or server-side CORS headers.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5184,
    proxy: {
      "/api": {
        target: "https://pagespace.ai",
        changeOrigin: true,
      },
    },
  },
});
