-- Statistics read whole sale histories through sales_statistics_cover_idx.
-- Index-only scans need an up-to-date visibility map; with the default
-- insert threshold (20 % of ~4 M rows) half the table was not all-visible and
-- every statistics pass read the heap from disk (2026-11-18). Vacuum after
-- every 10k new sales instead; on an insert-mostly table it is cheap.
ALTER TABLE sales SET (
    autovacuum_vacuum_insert_threshold = 10000,
    autovacuum_vacuum_insert_scale_factor = 0,
    autovacuum_analyze_scale_factor = 0.02
);
-- market_sales anti-joins every statistics read against the match links.
ALTER TABLE cross_source_sale_matches SET (
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_vacuum_insert_threshold = 5000,
    autovacuum_vacuum_insert_scale_factor = 0
);
