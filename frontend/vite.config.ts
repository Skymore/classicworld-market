import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  base: command === "serve" ? "/" : "/web/react/",
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8766",
      "/web": "http://127.0.0.1:8766",
      "/search": "http://127.0.0.1:8766",
    },
  },
  build: {
    outDir: "../web/react",
    emptyOutDir: true,
    cssCodeSplit: false,
    manifest: true,
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL("./src/main.tsx", import.meta.url)),
        shell: fileURLToPath(new URL("./src/server.tsx", import.meta.url)),
      },
      external: (id) => id.startsWith("/web/"),
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith(".css"))
            ? "style.css"
            : "assets/[name]-[hash][extname]",
      },
    },
  },
}));
