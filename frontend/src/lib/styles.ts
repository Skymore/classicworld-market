const pendingStyles = new Map<string, Promise<void>>();
export function ensureStyle(name: string) {
  const path = `/web/css/${name}.css?v=${__SITE_ASSET_VERSION__}`;
  if (!pendingStyles.has(path))
    pendingStyles.set(
      path,
      new Promise((resolve) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = path;
        link.onload = () => resolve();
        link.onerror = () => {
          pendingStyles.delete(path);
          resolve();
        };
        document.head.append(link);
      }),
    );
  return pendingStyles.get(path)!;
}
