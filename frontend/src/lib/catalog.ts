export const catalogKey = (url: string) => {
  const target = new URL(url, location.origin);
  // Presentation choices do not change the catalogue JSON. The SSR context
  // omits lang; normalize both keys so it can seed the same request.
  for (const key of ["lang", "theme", "device"]) target.searchParams.delete(key);
  target.searchParams.sort();
  return ["catalog", target.pathname + target.search];
};
export function readCatalogSnapshot() {
  const element = document.getElementById("catalog-snapshot");
  if (!element) return null;
  try {
    const snapshot = JSON.parse(element.textContent || "null");
    return snapshot?.data?.kind === "item" &&
      Number.isFinite(snapshot.updatedAt) &&
      JSON.stringify(catalogKey(snapshot.url)) ===
        JSON.stringify(catalogKey(location.pathname + location.search))
      ? snapshot
      : null;
  } catch {
    return null;
  } finally {
    element.remove();
  }
}
export async function loadCatalog(url: string, signal?: AbortSignal, preview = false) {
  const response = await fetch(
    "/api/v1/catalog/page?" + new URLSearchParams({ url, ...(preview ? { preview: "true" } : {}) }),
    { signal, credentials: "same-origin", cache: "no-store" },
  );
  if (!response.ok)
    throw Object.assign(
      Error(response.status === 404 ? "not_found" : "unavailable"),
      { status: response.status },
    );
  return response.json();
}
