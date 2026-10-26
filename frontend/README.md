# Maple Market React frontend

React + TypeScript + Vite, React Router, TanStack Query, Radix controls and the AI SDK assistant. The existing `web/css` files remain the source of truth for the light/dark game-window theme. Tailwind has no reset.

```sh
cd frontend
pnpm install --frozen-lockfile
pnpm dev
pnpm build
```

React owns every page and its interactions: home, prices and sales, watch lists, collection alerts, assistant/history, account, privacy, contributors, download, browser capture and the item/monster/map/search/route catalogue. There is no legacy-page mount adapter. Existing legacy assets stay available to already-open browser sessions.

Direct catalogue links retain their escaped Rust-rendered first paint and HTTP statuses for indexing and no-JavaScript visitors. The shared React application takes over using `/api/v1/catalog/page`, backed by the same queries and filter normalization. React owns catalogue filters, offer dialogs, instance stats, channel/room views, ladder, trend and quick previews; it never fetches an HTML fragment to replace the page.

The parser-blocking `boot.js` sets the theme before CSS. React uses the same account-scoped storage facade as watch settings and preferences. Keep initial theme resolution out of a mount effect. URL parameters own filters and sorting; the single market SSE stream invalidates market queries.

The screen reader/worker/structured-upload protocol is unchanged. `web/collect/engine.js` exposes an observable state controller and lifecycle methods; React renders all capture UI. Leaving capture stops tracks, terminates workers, cancels pending upload requests and releases local frame bitmaps. Collector tokens stay in existing storage and authorization headers. Alert history stays separated by hashed collector identity.

Build assets go to `web/react`. Stable revalidated entry files load hashed chunks. Preserve chunks from deployed releases so already-open pages can finish lazy imports. Deploy the matching executable and assets through the existing immutable bundle/supervisor workflow.

The Tools tab opens `/tools`; enhancement planning lives at `/tools/enhancement`, and collection keeps its existing `/alerts`, `/collect/` and download URLs. These collection routes select Tools in the main navigation.

Enhancement uses the selected equipment's CW `tuc` and matching scroll family, structured success rates and stat gains (then English CW descriptions), and compares 10% and 60% scrolls together. The user types a minimum stat gain; overshooting is allowed. Renewal policy iteration minimises total equipment and scroll costs, choosing a scroll or abandonment at every state. The result includes expected equipment and scroll counts and the reachable step-by-step policy. Destructive and special scrolls are unsupported. Equipment quotes require zero successful enhancements and the full original slot count; spent-slot and unparsed equipment are excluded. Quotes are observed unit asks, not a guarantee of repeat purchases. Manual prices survive SSE updates; “Use” restores automatic prices. Missing-price scrolls are explicitly excluded, never priced at zero. The expectation assumes independent rolls, consumed slots on failure, immediate stopping at the target and zero resale value for discarded items. Regressions: `node --test web/tests/enhancement.test.mjs`, `node web/tests/enhancement.e2e.mjs`, and the isolated-database Rust `enhancement` test.

Equipment bonus filters compare captured stats with catalogue reference values and exclude physical/magic defence; an enhancement count alone does not qualify. Attribute filters use the actual captured value (default minimum 1), never a catalogue fallback. Equipment cards combine defence rolls when every other stat, enhancement count and remaining-upgrade count matches, showing defence ranges, the combined listing count and the lowest offer price. Individual offer details retain their original stats.

The equipment header's bonus-only switch shares the global filter's equipment condition. Switching it off restores all equipment while retaining other conditions; the switch remains available when no offers match.

The item page has one filter dialog. Multiple stat minimums are combined with AND; the old single-stat preference migrates automatically. Attribute and captured/bonus conditions reach the catalogue API before sale pagination and price aggregation. Cards, listing locations and recent sales use the same conditions. Stock conditions apply to current offers only. Clicking an equipment card opens `/item/<id>?variant=<id>`: the server resolves the saved instance to its full group, ignoring defence rolls and retaining enhancements and upgrade slots. Quotes, sale samples and seven-day charts are scoped to that group, including after refresh, direct navigation and SSE. Equipment sale rows show time and the shared compact captured-stat summary directly on their second line, without a disclosure or extra action. Missing stats are identified explicitly.

Validation: `pnpm check`, `pnpm build`, `node --test web/tests/*.test.mjs`, and isolated browser fixtures `accounts`, `agent`, `contributors`, `search`, `react-migration`, `react-complete`, `item-offer-filters`, `item-preview-live`, `live-search-focus`, and `equipment-filters` (`.e2e.mjs`). Real candidate/public checks use `THEME_TEST_ORIGIN`, `REACT_VERIFY_ORIGIN` and `FILTER_TEST_ORIGIN` with `theme`, `react-live`, `react-complete-live` and `filter-layout`. Set `PLAYWRIGHT_MODULE` / `PLAYWRIGHT_CHANNEL` for an external Playwright runtime.
