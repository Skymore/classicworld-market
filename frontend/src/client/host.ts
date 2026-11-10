// The collector window around these pages. The sweep engine and the device sign-in live in
// the collector's own process, so the pages ask the window to act: a request goes to the
// parent frame as a message and the window answers with the result. The window decides
// which actions a page may call (frontend/desktop/site-page.tsx); nothing secret crosses.
import { useEffect, useState } from "react";

/** What the collector window tells its pages about itself. */
export interface HostShell {
  version: string;
  updates: string;
  uploaded: number;
  gameLive: boolean;
  gameLabel: string;
  /** From the watch tab; null until it has loaded. */
  watch: { watches: number; synced: boolean } | null;
}

const TIMEOUT_MS = 30_000;
let sequence = 0;
const waiting = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
let shell: HostShell | null = null;
const shellListeners = new Set<(shell: HostShell) => void>();

window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.source === window) return;
  const data = event.data;
  if (data?.type === "cwm-rpc-result") {
    const call = waiting.get(data.id);
    if (!call) return;
    waiting.delete(data.id);
    if (data.ok) call.resolve(data.value);
    else call.reject(Error(String(data.error || "unavailable")));
  } else if (data?.type === "cwm-shell" && data.shell && typeof data.shell === "object") {
    shell = data.shell as HostShell;
    shellListeners.forEach((listener) => listener(shell!));
  }
});

/** Ask the collector window to run a workspace action; rejects with its short error text. */
export function hostCall(action: string, value?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    waiting.set(id, { resolve, reject });
    window.parent.postMessage({ type: "cwm-rpc", id, action, value }, "*");
    setTimeout(() => {
      if (waiting.delete(id)) reject(Error("unavailable"));
    }, TIMEOUT_MS);
  });
}

/** The collector window's own state (version, game connection, watch sync); null until it arrives. */
export function useHostShell() {
  const [value, setValue] = useState<HostShell | null>(shell);
  useEffect(() => {
    shellListeners.add(setValue);
    window.parent.postMessage({ type: "cwm-shell-request" }, "*");
    return () => void shellListeners.delete(setValue);
  }, []);
  return value;
}
