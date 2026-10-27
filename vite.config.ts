import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
const buildId = new Date().toISOString();
export default defineConfig({
  define: { __SONDER_BUILD_ID__: JSON.stringify(buildId) },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "sonder-build-info",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "build.json",
          source: JSON.stringify({ id: buildId }),
        });
      },
    },
  ],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:3001" } },
  build: { target: "es2022" },
});
