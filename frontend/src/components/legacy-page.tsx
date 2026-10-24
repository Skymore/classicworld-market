import { useEffect, useRef, useState } from "react";
import { usePreferences } from "../providers";
import { ErrorState } from "./shared";

const css: Record<string, string> = {
  watch: "lists",
  alerts: "lists",
  sales: "lists",
  selling: "selling",
  agent: "agent",
  privacy: "account",
};
const pendingStyles = new Map<string, Promise<void>>();
export function ensureStyle(name: string) {
  const path = `/web/css/${name}.css?v=20261023-react-1`;
  if (!pendingStyles.has(path))
    pendingStyles.set(
      path,
      new Promise((resolve) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = path;
        link.onload = () => resolve();
        link.onerror = () => {
          pendingStyles.delete(path);
          resolve();
        };
        document.head.append(link);
      }),
    );
  return pendingStyles.get(path)!;
}
// Keep the mature acquisition/notification controllers isolated behind a
// lifecycle boundary. React owns the route and shell; controllers own only
// this empty host and must release listeners/requests when the route leaves.
export function LegacyPage({
  name,
  embedded = false,
}: {
  name: string;
  embedded?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const { language } = usePreferences();
  const [failed, setFailed] = useState(false);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    const root = host.current!;
    let active = true;
    let cleanup: (() => void) | undefined;
    setFailed(false);
    async function mount() {
      try {
        await ensureStyle(css[name] || "lists");
        const url = `/web/js/pages/${name}.js?v=20261023-header-icons-2`;
        const module = await import(/* @vite-ignore */ url);
        if (!active) return;
        const stop = await module.mount(root, {
          embedded,
          lang: language,
          page: name,
        });
        if (!active) stop?.();
        else {
          cleanup = stop;
          document.documentElement.dataset.ready = "1";
        }
      } catch (error) {
        if (active) {
          console.error(error);
          setFailed(true);
          document.documentElement.dataset.ready = "1";
        }
      }
    }
    void mount();
    return () => {
      active = false;
      cleanup?.();
      root.replaceChildren();
    };
  }, [name, embedded, language, attempt]);
  return (
    <>
      {failed && <ErrorState retry={() => retry((n) => n + 1)} />}
      <div className="legacy-page" ref={host} data-legacy-controller={name} />
    </>
  );
}
