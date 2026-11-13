-- Items whose price figures wait for the background recompute (stats::recompute_dirty).
-- Writers only mark items here, inside their transaction, so the shared write
-- lock is not held while whole sale histories are loaded and recomputed.
CREATE TABLE stats_dirty (
    item_id integer PRIMARY KEY,
    seen_at timestamptz,
    marked_at timestamptz NOT NULL DEFAULT now()
);
