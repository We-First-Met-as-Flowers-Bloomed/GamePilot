import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: "apps/desktop/renderer",
  base: "./",
  plugins: [
    react(),
    {
      name: "development-csp",
      apply: "serve",
      transformIndexHtml(html) {
        return html.replace(
          /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/i,
          "",
        );
      },
    },
  ],
  build: { outDir: "../../../dist/renderer", emptyOutDir: true },
});
