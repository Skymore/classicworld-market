import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  lang as legacyLanguage,
  setLang,
  nextLanguage,
  resolveLanguage,
  ipLanguage,
  loadKorean,
  koText,
} from "/web/js/lib/i18n.js";
import { setUnits, usesWan, unitChoiceNow } from "/web/js/lib/format.js";
import { userStorage, ready as userDataReady } from "/web/js/lib/user-data.js";
import { DataProvider } from "./lib/query";
import type { Language, Theme } from "./lib/types";

const subscribeLanguage = (callback: () => void) => {
  document.addEventListener("langchange", callback);
  return () => document.removeEventListener("langchange", callback);
};
const subscribeUnits = (callback: () => void) => {
  document.addEventListener("unitschange", callback);
  return () => document.removeEventListener("unitschange", callback);
};
/** "wan" (万 / 亿) or "km" (K / M), as numbers render now. */
export type Units = "wan" | "km";
const unitsNow = (): Units => (usesWan() ? "wan" : "km");
const Preferences = createContext<{
  language: Language;
  theme: Theme;
  toggleTheme(): void;
  changeLanguage(): void;
  /** Number units now in use, and the saved choice (null: the language default). */
  units: Units;
  unitChoice: Units | null;
  changeUnits(value: Units | null): void;
  server: boolean;
  ready: boolean;
} | null>(null);
// Theme and language follow the system / browser. `uiTheme` / `uiLang` hold
// an explicit choice from the switches, removed again once it matches the
// system; `?theme=` / `?lang=` hold for the tab (boot.js, sessionStorage).
function storedTheme() {
  try {
    return userStorage.getItem("uiTheme");
  } catch {
    return null;
  }
}
function viewTheme() {
  try {
    return sessionStorage.getItem("cwm.view.theme");
  } catch {
    return null;
  }
}
const darkScheme = () => matchMedia("(prefers-color-scheme: dark)");
/** The system theme; a system that states none is dark from 19:00 to 07:00. */
export function systemTheme(): Theme {
  if (darkScheme().matches) return "dark";
  if (matchMedia("(prefers-color-scheme: light)").matches) return "light";
  const hour = new Date().getHours();
  return hour >= 19 || hour < 7 ? "dark" : "light";
}
function chosenTheme(): Theme | null {
  for (const value of [viewTheme(), storedTheme()])
    if (value === "dark" || value === "light") return value;
  return null;
}
function applyPreferences() {
  document.documentElement.dataset.theme = chosenTheme() || systemTheme();
  const language = resolveLanguage();
  if (language !== legacyLanguage) setLang(language, { save: false });
  try {
    setUnits(userStorage.getItem("units"));
  } catch {
    setUnits(null);
  }
}
let preferencesInitialized = false;
let initialization: Promise<void> | undefined;
export function initializePreferences() {
  return (initialization ??= initialize());
}
async function initialize() {
  await userDataReady;
  applyPreferences();
  // A browser that names no language: the server's guess from the IP country.
  const guessed = await ipLanguage();
  if (guessed && guessed !== legacyLanguage) setLang(guessed, { save: false });
  if (legacyLanguage === "ko") await loadKorean();
  preferencesInitialized = true;
  window.dispatchEvent(new Event("user-preferences"));
}
export function Providers({
  children,
  server = false,
}: {
  children: ReactNode;
  server?: boolean;
}) {
  const [ready, setReady] = useState(preferencesInitialized);
  const language = useSyncExternalStore(
    subscribeLanguage,
    () => legacyLanguage as Language,
  );
  // Also follows the language (English always uses K / M), which re-renders here.
  const units = useSyncExternalStore(subscribeUnits, unitsNow, unitsNow);
  const choice = () => unitChoiceNow() as Units | null;
  const unitChoice = useSyncExternalStore(subscribeUnits, choice, choice);
  useEffect(() => {
    // Read by modules that cannot import format.js (the sweep labels).
    document.documentElement.dataset.units = units;
  }, [units, language]);
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  useEffect(() => {
    document.documentElement.dataset.lang = language;
    document.documentElement.lang = language === "zh" ? "zh-CN" : language;
  }, [language]);
  useEffect(() => {
    const update = () =>
      setTheme(
        document.documentElement.dataset.theme === "dark" ? "dark" : "light",
      );
    const system = darkScheme();
    const followSystem = () => {
      if (!chosenTheme()) {
        document.documentElement.dataset.theme = systemTheme();
        update();
      }
    };
    // The browser's language changed (Chrome applies it to open tabs).
    const followLanguage = () => {
      const next = resolveLanguage();
      if (next !== legacyLanguage) setLang(next, { save: false });
    };
    const storage = (event: StorageEvent) => {
      if (event.key === "units" || event.key === "uiLang" || event.key === null)
        applyPreferences();
      if (event.key === "uiTheme" || event.key === null) {
        document.documentElement.dataset.theme = chosenTheme() || systemTheme();
        update();
      }
    };
    const preferences = () => {
      if (!preferencesInitialized) return;
      applyPreferences();
      update();
      setReady(true);
    };
    document.addEventListener("themechange", update);
    window.addEventListener("storage", storage);
    window.addEventListener("user-preferences", preferences);
    system.addEventListener("change", followSystem);
    window.addEventListener("languagechange", followLanguage);
    // Also handle initialization that finished before this effect subscribed.
    let active = true;
    void initializePreferences().then(() => {
      if (active) preferences();
    });
    return () => {
      active = false;
      document.removeEventListener("themechange", update);
      window.removeEventListener("storage", storage);
      window.removeEventListener("user-preferences", preferences);
      system.removeEventListener("change", followSystem);
      window.removeEventListener("languagechange", followLanguage);
    };
  }, []);
  function toggleTheme() {
    const next =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    try {
      sessionStorage.removeItem("cwm.view.theme");
    } catch {
      /* private mode */
    }
    try {
      // Matching the system again means "follow the system".
      if (next === systemTheme()) userStorage.removeItem("uiTheme");
      else userStorage.setItem("uiTheme", next);
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
  function changeUnits(value: Units | null) {
    try {
      if (value) userStorage.setItem("units", value);
      else userStorage.removeItem("units");
    } catch {
      /* keep this session usable */
    }
    setUnits(value);
  }
  function changeLanguage() {
    // 中文 -> English -> 한국어; saved only while it differs from the browser.
    const next = nextLanguage(language) as Language;
    setLang(next);
    const url = new URL(location.href);
    if (server) {
      url.searchParams.set("lang", next);
      location.assign(url);
    } else if (url.searchParams.has("lang")) {
      url.searchParams.delete("lang");
      history.replaceState(history.state, "", url);
    }
  }
  return (
    <Preferences.Provider
      value={{
        language,
        theme,
        toggleTheme,
        changeLanguage,
        units,
        unitChoice,
        changeUnits,
        server,
        ready,
      }}
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
/** The text for a language. Korean comes from the dictionary keyed by the
 * Chinese text (and the client's game names), falling back to English. */
export function words(language: Language, zh: string, en: string) {
  if (language === "zh") return zh;
  if (language === "en") return en;
  return koText(zh, en) ?? en ?? zh;
}
/** `words("中文", "English")` for the page language. */
export function useWords() {
  const { language } = usePreferences();
  return (zh: string, en: string) => words(language, zh, en);
}
