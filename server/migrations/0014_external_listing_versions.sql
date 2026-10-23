-- Retain the latest per-item projection even if an export has no live quotes.
-- Older exports must not resurrect quotes omitted by a newer snapshot.
CREATE TABLE external_market_item_state (
    source text NOT NULL,
    source_item_id text NOT NULL,
    generated_at timestamptz NOT NULL,
    PRIMARY KEY(source,source_item_id)
);
INSERT INTO external_market_item_state(source,source_item_id,generated_at)
    SELECT source,source_item_id,max(source_generated_at)
    FROM external_market_listings GROUP BY source,source_item_id;
