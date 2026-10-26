import { useEffect, useState, useSyncExternalStore } from "react";
import { live } from "/web/js/lib/api.js?v=20261022-auto-watch-2";
import { userStorage } from "/web/js/lib/user-data.js";

export function useLiveData<T = any>(
  url: string | null,
  headers?: Record<string, string>,
) {
  const [state, setState] = useState<{
    data?: T;
    error: boolean;
    loading: boolean;
  }>({ error: false, loading: true });
  const signature = JSON.stringify(headers || {});
  useEffect(() => {
    if (!url) {
      setState({ error: false, loading: false });
      return;
    }
    setState({ error: false, loading: true });
    return live(
      url,
      (data: T) => setState({ data, error: false, loading: false }),
      {
        headers: JSON.parse(signature),
        onError: () =>
          setState((old) => ({ ...old, error: true, loading: false })),
      },
    );
  }, [url, signature]);
  return state;
}
const subscribe = (callback: () => void) => {
  window.addEventListener("storage", callback);
  document.addEventListener("watchchange", callback);
  window.addEventListener("user-preferences", callback);
  return () => {
    window.removeEventListener("storage", callback);
    document.removeEventListener("watchchange", callback);
    window.removeEventListener("user-preferences", callback);
  };
};
export function useUserValue(key: string, fallback = "") {
  const [temporary, setTemporary] = useState<{
    key: string;
    value: string;
  } | null>(null);
  useEffect(() => {
    const reset = () => setTemporary(null);
    window.addEventListener("user-preferences", reset);
    return () => window.removeEventListener("user-preferences", reset);
  }, [key]);
  const value = useSyncExternalStore(
    subscribe,
    () =>
      (temporary?.key === key ? temporary.value : null) ??
      userStorage.getItem(key) ??
      fallback,
  );
  const write = (next: string) => {
    try {
      userStorage.setItem(key, next);
      setTemporary(null);
    } catch {
      setTemporary({ key, value: next });
    }
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: next }));
  };
  return [value, write] as const;
}
export function downloadFile(
  name: string,
  data: BlobPart,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
