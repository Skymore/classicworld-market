import { use } from "react";
const pendingStyles = new Map<string, Promise<void>>();
export function ensureStyle(name: string) {
  const path = `/web/css/${name}.css?v=${__SITE_ASSET_VERSION__}`;
  if (!pendingStyles.has(path))
    pendingStyles.set(
      path,
      new Promise((resolve) => {
        const href = new URL(path, location.href).href;
        const existing = Array.from(
          document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
        ).find((link) => link.href === href);
        // HTML already loads the common styles. Reuse only the exact version;
        // a cached old stylesheet must not satisfy a new component's request.
        if (existing?.sheet) {
          resolve();
          return;
        }
        const link = existing ?? document.createElement("link");
        const finish = () => {
          link.removeEventListener("load", finish);
          link.removeEventListener("error", failed);
          resolve();
        };
        const failed = () => {
          pendingStyles.delete(path);
          finish();
        };
        link.addEventListener("load", finish);
        link.addEventListener("error", failed);
        if (!existing) {
          link.rel = "stylesheet";
          link.href = path;
          document.head.append(link);
        } else if (document.readyState === "complete") finish();
      }),
    );
  return pendingStyles.get(path)!;
}
function applied(name: string) {
  const href = new URL(
    `/web/css/${name}.css?v=${__SITE_ASSET_VERSION__}`,
    location.href,
  ).href;
  return Array.from(
    document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
  ).some((link) => link.href === href && link.sheet);
}
const styleGroups = new Map<string, Promise<unknown>>();
/** Suspends a component until these stylesheets apply; no wait when the page links them. */
export function useStyles(names: string[]) {
  if (names.every(applied)) return;
  const key = names.join(" ");
  if (!styleGroups.has(key))
    styleGroups.set(key, Promise.all(names.map(ensureStyle)));
  use(styleGroups.get(key)!);
}
