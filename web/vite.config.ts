import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const target = `http://127.0.0.1:${process.env.APPLYPILOT_PORT ?? "4317"}`;

// Dev: `npm run app` (API on 4317) + `npm run web:dev` (this, with hot reload) — API calls are proxied.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
  server: { host: "127.0.0.1", port: 5173, proxy: { "/api": { target, changeOrigin: false }, "/mock": { target, changeOrigin: false } } },
});
