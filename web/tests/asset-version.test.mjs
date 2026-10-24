import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetVersion, versionHtml } from "../../frontend/build-assets.ts";

test("entry, preload, styles and boot URLs share the generated version", async () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const version = (await readFile(path.join(root, "web/react/asset-version.txt"), "utf8")).trim();
  assert.match(version, /^[0-9a-f]{16}$/);
  assert.equal(assetVersion(root), version);
  for (const name of ["index.html", "download.html", "collect/index.html"]) {
    const html = await readFile(path.join(root, "web", name), "utf8");
    const urls = [...html.matchAll(/(?:href|src)="(\/web\/(?:react\/(?:app|shell)\.js|react\/style\.css|css\/[\w-]+\.css|js\/lib\/boot\.js)[^"]*)"/g)].map(match => match[1]);
    assert(urls.length > 0, name);
    for (const url of urls) assert.equal(new URL(url, "http://fixture").searchParams.get("v"), version, url);
  }
  assert.equal(versionHtml('<script src="/web/react/shell.js?v=old"></script><a href="https://example.com/app.js?v=old">x</a>', version), `<script src="/web/react/shell.js?v=${version}"></script><a href="https://example.com/app.js?v=old">x</a>`);
});

test("source changes invalidate entry URLs while CRLF checkout differences do not", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "site-entry-version-"));
  try {
    for (const folder of ["frontend/src", "web/css", "web/js"]) await mkdir(path.join(root, folder), { recursive: true });
    for (const file of ["frontend/package.json", "frontend/pnpm-lock.yaml", "frontend/vite.config.ts", "frontend/build-assets.ts"]) await writeFile(path.join(root, file), "fixture\n");
    const source = path.join(root, "frontend/src/main.tsx");
    await writeFile(source, "old menu\n"); const previous = assetVersion(root);
    await writeFile(source, "old menu\r\n"); assert.equal(assetVersion(root), previous);
    await writeFile(source, "new menu\n"); assert.notEqual(assetVersion(root), previous);
  } finally { await rm(root, { recursive: true }); }
});
