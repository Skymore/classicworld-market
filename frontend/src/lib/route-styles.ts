// Site stylesheets (web/css) each route needs before it renders. vite.config.ts
// has the build write CATALOGUE_STYLES into web/react/preload.json so the
// server-rendered catalogue pages can start these downloads from <head>.
export const CATALOGUE_STYLES = ["dex", "item", "prices", "lists"];
// Every other route keeps the full set the home page links in index.html.
export const SITE_STYLES = ["home", "prices", "account", "lists"];
