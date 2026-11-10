// The collector opens site pages with ?embed=1. Read once at load so in-app
// navigation keeps the embedded layout (compact navigation, no site dock or assistant).
export const embedded =
  new URLSearchParams(location.search).get("embed") === "1";
if (embedded) document.documentElement.dataset.embed = "1";
/** Embedded and served by the collector's own loopback gateway (its 关注 and 摆摊 tabs):
 * the collector's tab bar is the navigation, and local endpoints such as the bag exist. */
export const embeddedLocal =
  embedded && ["127.0.0.1", "localhost"].includes(location.hostname);
