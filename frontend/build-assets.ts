import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Plugin } from "vite";

export function assetVersion(root: string) {
  const hash = createHash("sha256");
  function visit(folder: string) {
    for (const item of readdirSync(folder, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const file = join(folder, item.name);
      if (item.isDirectory()) visit(file);
      else
        hash
          .update(relative(root, file).replaceAll("\\", "/") + "\0")
          .update(readFileSync(file, "utf8").replaceAll("\r\n", "\n"));
    }
  }
  for (const folder of ["frontend/src", "web/css", "web/js"])
    visit(join(root, folder));
  for (const file of [
    "frontend/package.json",
    "frontend/pnpm-lock.yaml",
    "frontend/vite.config.ts",
    "frontend/build-assets.ts",
  ])
    hash.update(
      readFileSync(join(root, file), "utf8").replaceAll("\r\n", "\n"),
    );
  return hash.digest("hex").slice(0, 16);
}

export function versionHtml(html: string, version: string) {
  return html.replace(
    /(\b(?:href|src)=["'])(\/web\/(?:react\/(?:app|shell)\.js|react\/style\.css|css\/[\w-]+\.css|js\/lib\/boot\.js))(?:\?[^"']*)?(["'])/g,
    (_, prefix, asset, quote) => `${prefix}${asset}?v=${version}${quote}`,
  );
}

export function versionAssets(root: string, version: string): Plugin {
  return {
    name: "version-site-entry-assets",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "asset-version.txt",
        source: version + "\n",
      });
    },
    writeBundle() {
      for (const name of [
        "index.html",
        "download.html",
        "collect/index.html",
      ]) {
        const file = join(root, "web", name);
        const html = readFileSync(file, "utf8");
        const output = versionHtml(html, version);
        if (html !== output) writeFileSync(file, output);
      }
    },
  };
}
