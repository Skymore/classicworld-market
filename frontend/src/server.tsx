import { createRoot } from "react-dom/client";
import { flushSync, createPortal } from "react-dom";
import { BrowserRouter } from "react-router-dom";
import { lang } from "/web/js/lib/i18n.js";
import { Providers, initializePreferences } from "./providers";
import { PhoneHeader, DesktopHeader, Navigation } from "./components/shell";
import "./styles.css";

// The Rust-rendered main stays intact for instant content and indexing.
// Shared React components take ownership of header/navigation only.
const html = document.documentElement;
await initializePreferences();
const params = new URLSearchParams(location.search);
if (!params.has("lang") && html.dataset.lang && html.dataset.lang !== lang) {
  const url = new URL(location.href);
  url.searchParams.set("lang", lang);
  location.replace(url);
} else {
  html.dataset.reactShell = "1";
  const freshness = document
    .querySelector("[data-as-of]")
    ?.getAttribute("data-as-of");
  if (freshness) html.dataset.freshness = freshness;
  const phone = document.querySelector(".ptop");
  const desktop = document.querySelector(".dhead");
  const dock = document.querySelector(".dock");
  const root = document.createElement("div");
  root.id = "site-react-shell";
  document.body.append(root);
  flushSync(() => {
    phone?.replaceChildren();
    desktop?.replaceChildren();
    dock?.replaceChildren();
    createRoot(root).render(
      <BrowserRouter>
        <Providers server>
          {phone && createPortal(<PhoneHeader />, phone)}
          {desktop && createPortal(<DesktopHeader />, desktop)}
          {dock && createPortal(<Navigation dock />, dock)}
        </Providers>
      </BrowserRouter>,
    );
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.key !== "/" ||
      event.ctrlKey ||
      event.metaKey ||
      /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")
    )
      return;
    const input = [
      ...document.querySelectorAll<HTMLInputElement>("input[type=search]"),
    ].find((node) => node.offsetParent !== null);
    if (input) {
      event.preventDefault();
      input.focus();
    }
  });
  void import(/* @vite-ignore */ "/web/js/pages/dex.js?v=20261023-react-1");
}
