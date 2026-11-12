// Per-tab page memory for this browser tab (sessionStorage): the last page of
// each main navigation section (its URL keeps the filters), scroll positions
// and small per-page values. Switching tabs returns to where the user left off.
import { useEffect, useState } from "react";

const KEY = "page-memory:v1";
type Memory = {
  sections: Record<string, string>;
  scroll: Record<string, number>;
  values: Record<string, unknown>;
};
let memory: Memory = (() => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (saved && typeof saved === "object")
      return {
        sections: saved.sections || {},
        scroll: saved.scroll || {},
        values: saved.values || {},
      };
  } catch {}
  return { sections: {}, scroll: {}, values: {} };
})();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(memory));
    } catch {}
  }, 150);
}
addEventListener("pagehide", () => {
  clearTimeout(saveTimer);
  try {
    sessionStorage.setItem(KEY, JSON.stringify(memory));
  } catch {}
});

const inside = (path: string, prefixes: string[]) =>
  prefixes.some((prefix) => path === prefix || path.startsWith(prefix + "/"));
const TOOLS = ["/tools", "/alerts", "/collect", "/web/download.html", "/contributors", "/traffic"];
const CATALOGUE = ["/search", "/item", "/mob", "/map", "/npc", "/route"];

/** The main navigation entry a path belongs to. */
export function navSection(path: string) {
  if (path.startsWith("/agent")) return "agent";
  if (path.startsWith("/watch")) return "watch";
  if (path.startsWith("/grind") || path.startsWith("/g/")) return "grind";
  if (inside(path, TOOLS)) return "tools";
  if (path === "/" || path === "/v2" || path.startsWith("/prices") || path.startsWith("/sales"))
    return "home";
  if (inside(path, CATALOGUE)) return "dex";
  return null;
}

/** Pages a section returns to. Item/monster/map pages are reached from
 * everywhere, so the catalogue tab only remembers its own list (/search). */
function remembered(section: string, path: string) {
  if (section === "dex") return path === "/search";
  return section !== "agent";
}

const pageKey = (url: { pathname: string; search: string }) => {
  const params = new URLSearchParams(url.search);
  params.delete("embed");
  const search = params.toString();
  return url.pathname + (search ? "?" + search : "");
};

export function rememberLocation(url: { pathname: string; search: string; hash: string }) {
  const section = navSection(url.pathname);
  if (!section || !remembered(section, url.pathname)) return;
  const href = pageKey(url) + url.hash;
  if (memory.sections[section] === href) return;
  memory.sections[section] = href;
  persist();
}

/** Where a navigation entry leads: its last page, or its default. */
export function sectionHref(section: string, fallback: string) {
  return memory.sections[section] || fallback;
}

let restoring = false;
let restoreToken = 0;
export function watchScroll() {
  let frame = 0;
  const save = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (restoring) return;
      const key = pageKey(location);
      const y = Math.round(scrollY);
      if (y > 0) memory.scroll[key] = y;
      else delete memory.scroll[key];
      const keys = Object.keys(memory.scroll);
      if (keys.length > 60) delete memory.scroll[keys[0]];
      persist();
    });
  };
  addEventListener("scroll", save, { passive: true });
  return () => removeEventListener("scroll", save);
}

/** Returns to the saved scroll position once the page is tall enough. Data
 * arrives after the route renders, so this retries for a short while and
 * stops as soon as the user scrolls themselves. */
export function restoreScroll() {
  const target = memory.scroll[pageKey(location)] || 0;
  const token = ++restoreToken;
  scrollTo(0, target);
  if (!target) return;
  restoring = true;
  const started = performance.now();
  const stop = () => {
    if (token === restoreToken) restoring = false;
    removeEventListener("wheel", stop);
    removeEventListener("touchstart", stop);
    removeEventListener("keydown", stop);
  };
  addEventListener("wheel", stop, { passive: true });
  addEventListener("touchstart", stop, { passive: true });
  addEventListener("keydown", stop);
  const step = () => {
    if (token !== restoreToken || !restoring) return stop();
    if (Math.abs(scrollY - target) > 2) scrollTo(0, target);
    const reached =
      Math.abs(scrollY - target) <= 2 &&
      document.documentElement.scrollHeight - innerHeight >= target;
    if (performance.now() - started > 2500 || (reached && performance.now() - started > 600))
      return stop();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
export function cancelScrollRestore() {
  restoreToken++;
  restoring = false;
}

/** A value kept for this browser tab, such as a selected list. */
export function readMemory<T>(key: string, fallback: T): T {
  return key in memory.values ? (memory.values[key] as T) : fallback;
}
export function writeMemory(key: string, value: unknown) {
  memory.values[key] = value;
  persist();
}
export function useRemembered<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => readMemory(key, fallback));
  useEffect(() => writeMemory(key, value), [key, value]);
  return [value, setValue] as const;
}
