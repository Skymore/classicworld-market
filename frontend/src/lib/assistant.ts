import { useEffect, useSyncExternalStore } from "react";

// What the visitor is looking at, so the assistant can answer "this item" questions.
// The icon is only shown in the drawer; it is not sent with the question.
export type PageContext = { kind: "item" | "mob" | "map"; id: number; label: string; icon?: string };

// Phones show the assistant full screen, so it gets its own history entry: the
// system back button closes it instead of leaving the page underneath.
const phone = () => matchMedia("(max-width: 640px)").matches;
const marked = () => !!(history.state as { assistant?: boolean } | null)?.assistant;

let open = phone() && marked(),
  page: PageContext | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function setAssistantOpen(next: boolean) {
  if (open === next) return;
  if (!next && marked()) {
    history.back(); // the popstate below closes it
    return;
  }
  if (next && phone() && !marked())
    history.pushState({ ...history.state, assistant: true }, "");
  open = next;
  notify();
}
addEventListener("popstate", () => {
  if (!phone() || open === marked()) return;
  open = marked();
  notify();
});
export const useAssistantOpen = () => useSyncExternalStore(subscribe, () => open);
export const usePageContext = () => useSyncExternalStore(subscribe, () => page);

// Pages call this while mounted; the context clears when they unmount.
export function useProvidePageContext(next: PageContext | null) {
  const kind = next?.kind,
    id = next?.id,
    label = next?.label,
    icon = next?.icon;
  useEffect(() => {
    if (!kind || id == null || !label) return;
    page = { kind, id, label, icon };
    notify();
    return () => {
      page = null;
      notify();
    };
  }, [kind, id, label, icon]);
}
