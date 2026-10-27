-- Recomputing touched items needs compact pricing fields, never the source
-- payload. Keep each item's existing detection/tie order while avoiding wide
-- heap reads and a global disk sort on every upload and background batch.
CREATE INDEX sales_statistics_cover_idx ON sales
    (item_id, detected_at, observation_id, position, id)
    INCLUDE (kind, shop_id, external_shop_id, slot, variant_id, price, bundle, source_price);
