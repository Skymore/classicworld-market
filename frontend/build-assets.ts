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

/** Module and stylesheet files one route needs beyond what is already listed. */
export type RoutePreloads = { modules: string[]; styles: string[] };

/** `siteStyles`: the web/css files the catalogue route loads (src/lib/route-styles.ts). */
export function versionAssets(
  root: string,
  version: string,
  siteStyles: string[] = [],
): Plugin {
  let homePreloads: RoutePreloads = { modules: [], styles: [] };
  return {
    name: "version-site-entry-assets",
    apply: "build",
    generateBundle(_, bundle) {
      const chunk = (file: string) => {
        const output = bundle[file];
        return output?.type === "chunk" ? output : undefined;
      };
      // A chunk and everything it imports statically, dependencies in load order.
      const closure = (file: string, seen = new Set<string>()) => {
        const visit = (name: string) => {
          if (seen.has(name) || !chunk(name)) return;
          seen.add(name);
          for (const dependency of chunk(name)!.imports) visit(dependency);
        };
        visit(file);
        return seen;
      };
      const route = (source: string, loaded: Set<string>): RoutePreloads => {
        const entry = Object.values(bundle).find(
          (output) =>
            output.type === "chunk" &&
            output.facadeModuleId?.replaceAll("\\", "/").endsWith(source),
        );
        if (!entry) throw new Error(`no chunk for ${source}`);
        const modules = [...closure(entry.fileName)].filter((file) => !loaded.has(file));
        for (const file of modules) loaded.add(file);
        const styles = modules.flatMap((file) => [
          ...((chunk(file) as any)?.viteMetadata?.importedCss ?? []),
        ]);
        return { modules, styles: styles.filter((file) => file !== "style.css") };
      };
      // index.html: the home page's startup modules plus its price table.
      const app = closure("app.js");
      app.delete("app.js");
      homePreloads = route("src/pages/prices.tsx", new Set(["app.js"]));
      homePreloads.modules = [...app, ...homePreloads.modules.filter((file) => !app.has(file))];
      // Server-rendered pages: the shell entry's modules, the catalogue
      // route, and the search view the catalogue loads on /search.
      const shell = closure("shell.js");
      shell.delete("shell.js");
      const loaded = new Set(["shell.js", ...shell]);
      const preloads = {
        shell: [...shell],
        catalogue: route("src/pages/catalogue.tsx", loaded),
        search: route("src/pages/catalogue-search.tsx", loaded),
        siteStyles,
      };
      this.emitFile({
        type: "asset",
        fileName: "preload.json",
        source: JSON.stringify(preloads, null, 1) + "\n",
      });
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
        let output = versionHtml(html, version);
        if (name === "index.html") {
          // Flatten the startup module waterfall without loading other routes.
          const preloads =
            "  <!-- app-preloads:start -->\n" +
            [
              ...homePreloads.modules.map(
                (file) =>
                  `  <link rel="modulepreload" href="/web/react/${file}">`,
              ),
              ...homePreloads.styles.map(
                (file) =>
                  `  <link rel="preload" as="style" href="/web/react/${file}">`,
              ),
            ].join("\n") +
            "\n  <!-- app-preloads:end -->\n";
          output = output
            .replace(
              /  <!-- app-preloads:start -->[\s\S]*?<!-- app-preloads:end -->\r?\n/g,
              "",
            )
            .replace("</head>", preloads + "</head>");
        }
        if (html !== output) writeFileSync(file, output);
      }
    },
  };
}
