export const catalogKey = (url: string) => ["catalog", url];
export async function loadCatalog(url: string, signal?: AbortSignal) {
  const response = await fetch(
    "/api/v1/catalog/page?" + new URLSearchParams({ url }),
    { signal, credentials: "same-origin", cache: "no-store" },
  );
  if (!response.ok)
    throw Object.assign(
      Error(response.status === 404 ? "not_found" : "unavailable"),
      { status: response.status },
    );
  return response.json();
}
