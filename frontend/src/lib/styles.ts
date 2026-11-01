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
