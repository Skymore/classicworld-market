-- Select recent evidence before joining names, locations and equipment JSON.
CREATE INDEX listings_item_recent_idx ON listings
    (item_id, last_seen_at DESC, observation_id DESC, slot) WHERE stock > 0;
CREATE INDEX sales_item_recent_idx ON sales
    (item_id, detected_at DESC, observation_id DESC NULLS LAST,
     position DESC NULLS LAST, source_key) INCLUDE (id);
-- Collector status/alerts use receipt time, not the game observation time.
CREATE INDEX observations_collector_received_idx ON observations
    (collector_id, received_at DESC, id DESC);
