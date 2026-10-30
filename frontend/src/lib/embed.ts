// The collector opens site pages with ?embed=1. Read once at load so in-app
// navigation keeps the embedded layout (no site header, dock or assistant).
export const embedded =
  new URLSearchParams(location.search).get("embed") === "1";
if (embedded) document.documentElement.dataset.embed = "1";
