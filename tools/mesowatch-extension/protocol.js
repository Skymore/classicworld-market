export function allowedURL(url) {
  return url === 'https://meso.watch/data/list.json' ||
    /^https:\/\/meso\.watch\/data\/markets\/Classic%20World\/item\/(basil|cash)_[0-9]{8}\.json$/.test(url);
}

// Serialized by chrome.scripting; deliberately self-contained. Runs in an
// isolated world with the tab's same-origin credentials, not extension secrets.
export async function readMarketJSON(url) {
  if (location.origin !== 'https://meso.watch' ||
      !(url === 'https://meso.watch/data/list.json' ||
        /^https:\/\/meso\.watch\/data\/markets\/Classic%20World\/item\/(basil|cash)_[0-9]{8}\.json$/.test(url))) {
    return {error: 'unexpected_origin'};
  }
  try {
    const response = await fetch(url, {cache: 'no-cache', credentials: 'same-origin',
      signal: AbortSignal.timeout(45000)});
    const type = response.headers.get('content-type') || '';
    if (response.status !== 200 || !type.includes('json')) return {status: response.status, type};
    const text = await response.text();
    if (text.length > 24 * 1024 * 1024) return {error: 'response_too_large'};
    return {status: response.status, type, text};
  } catch {
    return {error: 'page_fetch_failed'};
  }
}
