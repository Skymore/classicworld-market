-- Cover historical per-item quote reads without visiting every wide row heap.
CREATE INDEX observation_rows_trend_idx ON observation_rows(item_id, observation_id)
INCLUDE(slot, variant_id, price, bundle)
WHERE stock > 0 AND price > 0 AND bundle > 0;
