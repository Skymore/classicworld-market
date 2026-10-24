import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { lang as legacyLanguage, setLang } from "/web/js/lib/i18n.js";
import { userStorage, ready as userDataReady } from "/web/js/lib/user-data.js";
import { DataProvider } from "./lib/query";
import type { Language, Theme } from "./lib/types";

const subscribeLanguage = (callback: () => void) => {
  document.addEventListener("langchange", callback);
  return () => document.removeEventListener("langchange", callback);
};
const Preferences = createContext<{
  language: Language;
  theme: Theme;
  toggleTheme(): void;
  changeLanguage(): void;
  server: boolean;
} | null>(null);
function storedTheme() {
  try {
    return userStorage.getItem("theme");
  } catch {
    return null;
  }
}
function applyPreferences() {
  const saved = storedTheme();
  document.documentElement.dataset.theme =
    saved === "dark" || saved === "light"
      ? saved
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  const language = userStorage.getItem("lang");
  if ((language === "zh" || language === "en") && language !== legacyLanguage)
    setLang(language);
}
export async function initializePreferences() {
  await userDataReady;
  const params = new URLSearchParams(location.search);
  for (const key of ["theme", "lang"]) {
    const value = params.get(key);
    if (
      (key === "theme" && (value === "dark" || value === "light")) ||
      (key === "lang" && (value === "zh" || value === "en"))
    ) {
      try {
        userStorage.setItem(key, value);
      } catch {
        /* keep the active preferences usable */
      }
    }
  }
  applyPreferences();
}
export function Providers({
  children,
  server = false,
}: {
  children: ReactNode;
  server?: boolean;
}) {
  const language = useSyncExternalStore(
    subscribeLanguage,
    () => legacyLanguage as Language,
  );
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  useEffect(() => {
    document.documentElement.dataset.lang = language;
    document.documentElement.lang = language === "en" ? "en" : "zh-CN";
  }, [language]);
  useEffect(() => {
    const update = () =>
      setTheme(
        document.documentElement.dataset.theme === "dark" ? "dark" : "light",
      );
    const system = matchMedia("(prefers-color-scheme: dark)");
    const followSystem = () => {
      if (!["dark", "light"].includes(storedTheme() || "")) {
        document.documentElement.dataset.theme = system.matches
          ? "dark"
          : "light";
        update();
      }
    };
    const storage = (event: StorageEvent) => {
      if (event.key === "theme" || event.key === null) {
        const saved = storedTheme();
        document.documentElement.dataset.theme =
          saved === "dark" || saved === "light"
            ? saved
            : system.matches
              ? "dark"
              : "light";
        update();
      }
    };
    const preferences = () => {
      applyPreferences();
      update();
    };
    document.addEventListener("themechange", update);
    window.addEventListener("storage", storage);
    window.addEventListener("user-preferences", preferences);
    system.addEventListener("change", followSystem);
    return () => {
      document.removeEventListener("themechange", update);
      window.removeEventListener("storage", storage);
      window.removeEventListener("user-preferences", preferences);
      system.removeEventListener("change", followSystem);
    };
  }, []);
  function toggleTheme() {
    const next =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    try {
      userStorage.setItem("theme", next);
    } catch {
      /* keep this session usable */
    }
    document.documentElement.dataset.theme = next;
    setTheme(next);
    const url = new URL(location.href);
    if (url.searchParams.has("theme")) {
      url.searchParams.set("theme", next);
      history.replaceState(history.state, "", url);
    }
    document.dispatchEvent(new CustomEvent("themechange", { detail: next }));
  }
  function changeLanguage() {
    const next = language === "zh" ? "en" : "zh";
    setLang(next);
    const url = new URL(location.href);
    url.searchParams.set("lang", next);
    if (server) location.assign(url);
    else history.replaceState(history.state, "", url);
  }
  return (
    <Preferences.Provider
      value={{ language, theme, toggleTheme, changeLanguage, server }}
    >
      <DataProvider>{children}</DataProvider>
    </Preferences.Provider>
  );
}
export function usePreferences() {
  const value = useContext(Preferences);
  if (!value) throw Error("Preferences provider missing");
  return value;
}
export function useWords() {
  const { language } = usePreferences();
  return (zh: string, en: string) => (language === "en" ? en : zh);
}
