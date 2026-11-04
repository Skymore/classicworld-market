import { getJson, seedJson } from "/web/js/lib/api.js?v=20261027-transfer-1";

export const catalogKey = (url: string) => {
  const target = new URL(url, location.origin);
  // Presentation choices do not change the catalogue JSON. The SSR context
  // omits lang; normalize both keys so it can seed the same request.
  for (const key of ["lang", "theme", "device", "embed"]) target.searchParams.delete(key);
  // Missing hours and explicit 72h select the same server snapshot.
  if (target.pathname.startsWith("/item/") && target.searchParams.get("hours") === "72")
    target.searchParams.delete("hours");
  target.searchParams.sort();
  return ["catalog", target.pathname + target.search];
};
export const sameCatalog = (a: string, b: string) =>
  JSON.stringify(catalogKey(a)) === JSON.stringify(catalogKey(b));
const SNAPSHOT_KINDS = ["item", "mob", "map", "npc", "route", "search"];
/** Page data a server-rendered page embeds (`page_data_script` in shell.rs). */
export function readCatalogSnapshot() {
  const element = document.getElementById("catalog-snapshot");
  if (!element) return null;
  try {
    const snapshot = JSON.parse(element.textContent || "null");
    const valid = SNAPSHOT_KINDS.includes(snapshot?.data?.kind) &&
      Number.isFinite(snapshot.updatedAt) &&
      sameCatalog(snapshot.url, location.pathname + location.search);
    if (!valid) return null;
    seedJson(catalogUrl(snapshot.url), snapshot.data, snapshot.etag, snapshot.updatedAt);
    return snapshot;
  } catch {
    return null;
  } finally {
    element.remove();
  }
}
const catalogUrl = (url: string, preview = false) =>
  "/api/v1/catalog/page?" + new URLSearchParams({ url: catalogKey(url)[1], ...(preview ? { preview: "true" } : {}) });
export async function loadCatalog(url: string, signal?: AbortSignal, preview = false) {
  return (await getJson(
    catalogUrl(url, preview),
    { signal },
  )).data;
}
