import { lazy, Suspense, useEffect, useState } from "react";
import { useLocation, useNavigationType } from "react-router-dom";
import { setAssistantOpen, useAssistantOpen } from "../lib/assistant";
import { useWords } from "../providers";
import { AssistantIcon } from "./assistant-icon";

const AssistantPanel = lazy(() =>
  import("../pages/agent").then((module) => ({ default: module.AssistantPanel })),
);

// Square launcher (desktop) and the assistant drawer, loaded on first open. The full
// /agent page replaces both, so they are not rendered there.
export function AssistantDock() {
  const words = useWords(),
    open = useAssistantOpen(),
    location = useLocation(),
    action = useNavigationType(),
    onPage = location.pathname.startsWith("/agent");
  const [used, setUsed] = useState(false);
  useEffect(() => {
    if (open) setUsed(true);
  }, [open]);
  // A link followed from the full-screen assistant shows its page; back returns to the assistant.
  useEffect(() => {
    if (action !== "POP" && matchMedia("(max-width: 640px)").matches) setAssistantOpen(false);
  }, [location.key, action]);
  useEffect(() => {
    if (!onPage) return;
    setAssistantOpen(false);
    setUsed(false);
  }, [onPage]);
  if (onPage) return null;
  return (
    <>
      {!open && (
        <button
          type="button"
          className="assistant-fab"
          onClick={() => setAssistantOpen(true)}
          aria-label={words("打开 AI 助手", "Open AI assistant")}
          title={words("AI 助手", "AI assistant")}
          data-assistant-open
        >
          <AssistantIcon size={34} />
        </button>
      )}
      {(used || open) && (
        <Suspense fallback={<aside className="assistant-drawer" aria-busy="true" />}>
          <AssistantPanel open={open} />
        </Suspense>
      )}
    </>
  );
}
