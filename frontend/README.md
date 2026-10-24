# Maple Market React frontend

React + TypeScript + Vite, React Router, TanStack Query and shadcn-style Radix components. The existing `web/css/base.css` tokens remain the source of truth for the approved light and dark game-window appearance. Tailwind utilities are included without its reset, so the existing typography and geometry stay intact.

```sh
cd frontend
pnpm install --frozen-lockfile
pnpm dev
pnpm build
```

Development proxies `/api`, `/web` and catalogue search to the existing Rust service on `127.0.0.1:8766`. Production assets are built into `web/react/`. `app.js` and `shell.js` are stable revalidated entry points, importing content-hashed chunks. Rust keeps serving the website, APIs, collector and server-rendered catalogue.

## Ownership

- React owns the persistent header, navigation, theme, routing, home, prices, account and contributor board. Shared controls live in `src/components/ui`; changing a library component does not replace the site's theme.
- Server-rendered item, monster, map, route and search pages keep their original main content. `server.tsx` mounts the same React chrome around it without replacing the main or changing indexing and direct-link behavior.
- `LegacyPage` isolates the mature watch, acquisition alerts, sales, assistant and private bag controllers. They can modify only their host. Cleanup handles must release requests/listeners on navigation, including when an asynchronous mount completes after the route has left. These controllers can be migrated individually without another shell/router rewrite.
- URL parameters own search, filters and sort. Query owns server snapshots; the existing single SSE stream invalidates active market queries. Account data is a separate query. Existing collector credentials and watchlist keys are preserved.
- The parser-blocking `boot.js` runs before CSS on every shell, including account themes cached under the last confirmed public account ID. React waits for account identity and uses the same storage facade for synchronized preferences. Do not move initial theme resolution into a mount effect.

## Validation

Run `pnpm check`, `pnpm build`, `node --test web/tests/*.test.mjs` from the appropriate directories, then the isolated browser fixtures `search.e2e.mjs`, `contributors.e2e.mjs`, `agent.e2e.mjs` and `react-migration.e2e.mjs`. `theme.e2e.mjs` targets a real candidate with `THEME_TEST_ORIGIN`. Set `PLAYWRIGHT_MODULE` and `PLAYWRIGHT_CHANNEL` when using an external Playwright installation.

Deploy generated frontend files and the matching Rust shell together through the existing immutable bundle and supervisor workflow.
