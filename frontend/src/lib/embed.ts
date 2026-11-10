// The collector opens site pages with ?embed=1. Read once at load so in-app
// navigation keeps the embedded layout (compact navigation, no site dock or assistant).
export const embedded =
  new URLSearchParams(location.search).get("embed") === "1";
if (embedded) document.documentElement.dataset.embed = "1";
/** A collector tab of its own (`own=1`): the collector's tab bar is the navigation, and the
 * collector window passes local data such as the bag to the page by message. */
export const embeddedHost =
  embedded && new URLSearchParams(location.search).get("own") === "1";
/** Embedded and served by the collector's own loopback gateway (older collectors' 摆摊 tab):
 * local endpoints such as the bag exist. */
export const embeddedLocal =
  embedded && !embeddedHost && ["127.0.0.1", "localhost"].includes(location.hostname);
