// Google sign-in always finishes on /account. Pages that send the user there
// remember themselves for this tab, and the account page goes back.
const KEY = "cwm.return-after-login.v1";
const MAX_AGE_MS = 10 * 60 * 1000;
const allowed = (path: unknown): path is string =>
  typeof path === "string" && /^\/(device|watch)(?:[?#]|$)/.test(path);

export function rememberReturn(path = location.pathname + location.search) {
  if (!allowed(path)) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ path, at: Date.now() }));
  } catch {
    /* without storage the user lands on /account, which still works */
  }
}

export function takeReturn(): string | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) || "null");
    sessionStorage.removeItem(KEY);
    return saved && allowed(saved.path) && Date.now() - saved.at < MAX_AGE_MS
      ? saved.path
      : null;
  } catch {
    return null;
  }
}
