-- Keep immutable evidence and quarantine upstream edits without aborting a run.
CREATE TABLE external_market_sale_conflicts (
    source text NOT NULL,
    source_key text NOT NULL,
    payload_hash text NOT NULL,
    original_payload jsonb NOT NULL,
    incoming_payload jsonb NOT NULL,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(source,source_key,payload_hash)
);
CREATE INDEX external_market_listings_version_idx
    ON external_market_listings(source,source_item_id,source_generated_at);
