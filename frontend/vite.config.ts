import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { assetVersion, versionAssets } from "./build-assets";
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const siteVersion = assetVersion(projectRoot);

export default defineConfig(({ command }) => ({
  plugins: [
    {
      name: "bundle-shared-site-modules",
      enforce: "pre",
      resolveId(id, importer) {
        const source = id.split("?")[0];
        if (source.startsWith("/web/js/")) return resolve(projectRoot, "." + source);
        // Versioned legacy imports must still share one account module instance.
        if (importer?.replaceAll("\\", "/").includes("/web/js/") && source.startsWith("."))
          return resolve(importer.split("?")[0], "..", source);
      },
    },
    react(), tailwindcss(), versionAssets(projectRoot, siteVersion),
  ],
  define: { __SITE_ASSET_VERSION__: JSON.stringify(siteVersion) },
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
    // Keep immutable hashed chunks for already-open pages with cached entry modules.
    emptyOutDir: false,
    cssCodeSplit: false,
    manifest: true,
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL("./src/main.tsx", import.meta.url)),
        shell: fileURLToPath(new URL("./src/server.tsx", import.meta.url)),
      },
      external: (id) => id.startsWith("/web/") && !id.startsWith("/web/js/"),
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
