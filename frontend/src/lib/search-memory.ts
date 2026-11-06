// The site search box keeps its text while moving between pages (this browser
// tab) and remembers the last searches on this device.
import { useSyncExternalStore } from "react";

const TEXT_KEY = "quick-search:text";
const RECENT_KEY = "quick-search:recent";
const RECENT_MAX = 8;

const read = (storage: () => Storage, key: string) => {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
};
const write = (storage: () => Storage, key: string, value: string | null) => {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch {}
};

let text = read(() => sessionStorage, TEXT_KEY) || "";
let recent: string[] = (() => {
  try {
    const saved = JSON.parse(read(() => localStorage, RECENT_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((row) => typeof row === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
})();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
addEventListener("storage", (event) => {
  if (event.key !== RECENT_KEY) return;
  try {
    recent = JSON.parse(event.newValue || "[]");
  } catch {
    recent = [];
  }
  emit();
});

export function setSearchText(next: string) {
  if (next === text) return;
  text = next;
  write(() => sessionStorage, TEXT_KEY, next || null);
  emit();
}
export const useSearchText = () => useSyncExternalStore(subscribe, () => text);
export const useRecentSearches = () => useSyncExternalStore(subscribe, () => recent);

export function rememberSearch(term: string) {
  const value = term.trim();
  if (!value) return;
  const key = value.toLowerCase();
  recent = [value, ...recent.filter((row) => row.toLowerCase() !== key)].slice(0, RECENT_MAX);
  write(() => localStorage, RECENT_KEY, JSON.stringify(recent));
  emit();
}
export function forgetSearch(term?: string) {
  recent = term === undefined ? [] : recent.filter((row) => row !== term);
  write(() => localStorage, RECENT_KEY, recent.length ? JSON.stringify(recent) : null);
  emit();
}
