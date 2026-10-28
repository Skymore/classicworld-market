import { useEffect } from "react";
import { queryClient } from "./query";
import { subscribeAccountEvents } from "/web/js/lib/user-data.js";

/** GET a signed-in account endpoint; errors carry the server's code. */
export async function getAccountJson<T>(path: string, signal?: AbortSignal) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(body.error || "unavailable");
  return body as T;
}

/** Refetches the query `key` whenever one of the account event `topics` arrives. */
export function useAccountTopics(
  topics: string[],
  key: readonly unknown[],
  enabled = true,
) {
  const signature = JSON.stringify([topics, key]);
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => void queryClient.invalidateQueries({ queryKey: key });
    const stops = topics.map((topic) => subscribeAccountEvents(topic, refresh));
    return () => stops.forEach((stop) => stop());
  }, [signature, enabled]);
}
