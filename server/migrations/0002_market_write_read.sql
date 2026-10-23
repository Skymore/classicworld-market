-- R1/R2 market write and read path. Adjusts 0001 to what the Python
-- reference stores, so replayed uploads give the same numbers:
-- slots carry the repeat counter (category*1000 + slot + repeat*1000000),
-- prices are per bundle and may be 0, unit prices and medians are fractional.

-- Collectors: Python members have a name and can be revoked.
ALTER TABLE collectors ADD COLUMN name text;
ALTER TABLE collectors ADD COLUMN active boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX collectors_token_hash_idx ON collectors (token_hash);

-- Python listing identity (market_dashboard.listing_shop), served as shop_key.
-- Game shop ids go up to 2^32-1.
ALTER TABLE shops ADD COLUMN public_key text NOT NULL;
ALTER TABLE shops ALTER COLUMN shop_id TYPE bigint;

-- fingerprint: digest of the cleaned upload, for idempotent retries.
-- visit_key: Python visit id digest([collector, observation_id]); orders
-- observations at the same time and seeds sale ids.
ALTER TABLE observations ADD COLUMN fingerprint text NOT NULL;
ALTER TABLE observations ADD COLUMN visit_key text NOT NULL;
DROP INDEX observations_shop_time_idx;
CREATE INDEX observations_shop_order_idx ON observations (shop_id, observed_at, visit_key);
CREATE INDEX observations_time_idx ON observations (observed_at);

ALTER TABLE observation_rows ALTER COLUMN slot TYPE integer;
ALTER TABLE observation_rows RENAME COLUMN unit_price TO price;   -- per bundle, as uploaded
ALTER TABLE observation_rows DROP CONSTRAINT observation_rows_unit_price_check;
ALTER TABLE observation_rows ADD CONSTRAINT observation_rows_price_check CHECK (price >= 0);
ALTER TABLE observation_rows ALTER COLUMN bundle TYPE integer;
ALTER TABLE observation_rows ADD COLUMN position smallint NOT NULL; -- row order in the upload

ALTER TABLE listings ALTER COLUMN slot TYPE integer;
ALTER TABLE listings RENAME COLUMN unit_price TO price;
ALTER TABLE listings ALTER COLUMN bundle TYPE integer;
ALTER TABLE listings ADD COLUMN observation_id bigint NOT NULL REFERENCES observations (id);
-- Covering, so recomputing an item's figures is an index-only scan; shop
-- rewrites scatter listings over many heap pages.
DROP INDEX listings_item_price_idx;
CREATE INDEX listings_item_live_idx ON listings (item_id)
    INCLUDE (shop_id, last_seen_at, variant_id, price, bundle) WHERE stock > 0;

-- price/bundle: the listing as last seen before the sale (the row itself for
-- found_sold); unit price = price / bundle.
ALTER TABLE sales ALTER COLUMN slot TYPE integer;
ALTER TABLE sales RENAME COLUMN unit_price TO price;
ALTER TABLE sales ADD COLUMN bundle integer NOT NULL;
ALTER TABLE sales ALTER COLUMN quantity TYPE bigint;
ALTER TABLE sales ADD COLUMN position smallint NOT NULL;           -- detection order in the observation
DROP INDEX sales_time_idx;
CREATE INDEX sales_feed_idx ON sales (detected_at DESC, observation_id DESC, position DESC);
CREATE INDEX sales_shop_idx ON sales (shop_id);

-- item_stats: window-independent sale figures plus the 72-hour quote window.
ALTER TABLE item_stats
    ALTER COLUMN typical TYPE double precision,
    ALTER COLUMN typical_low TYPE double precision,
    ALTER COLUMN typical_high TYPE double precision,
    ALTER COLUMN change_24h TYPE double precision,
    ALTER COLUMN lowest_ask TYPE double precision,
    ALTER COLUMN quick_sell TYPE double precision,
    ALTER COLUMN normal_sell TYPE double precision,
    ADD COLUMN typical_basis text NOT NULL DEFAULT 'recent',
    ADD COLUMN low_data boolean NOT NULL DEFAULT true,
    ADD COLUMN sales_prev_24h integer NOT NULL DEFAULT 0,
    ADD COLUMN sales_10d integer NOT NULL DEFAULT 0,
    ADD COLUMN last_sale_price double precision,
    ADD COLUMN last3_avg double precision,
    ADD COLUMN trend jsonb NOT NULL DEFAULT '[]',      -- 7 daily buckets ending at the anchor
    ADD COLUMN last_seen_at timestamptz,                -- latest observation of the item, any stock
    ADD COLUMN median_ask double precision,
    ADD COLUMN highest_ask double precision,
    ADD COLUMN variant_count integer NOT NULL DEFAULT 0,
    ADD COLUMN sold_out_count integer NOT NULL DEFAULT 0,
    ADD COLUMN sold_out_median double precision,
    ADD COLUMN sales_count integer NOT NULL DEFAULT 0,
    ADD COLUMN recommendation jsonb,
    -- The list entry's market fields as JSON members (no braces), written with
    -- the row. The list joins them to catalogue fields instead of decoding
    -- twenty columns per item on every request.
    ADD COLUMN list_fields text NOT NULL DEFAULT '';

-- The quote-window columns of item_stats over all records (?hours=all).
CREATE TABLE item_stats_all (
    item_id         integer PRIMARY KEY REFERENCES items (id),
    lowest_ask      double precision,
    median_ask      double precision,
    highest_ask     double precision,
    listings_count  integer NOT NULL DEFAULT 0,
    shops_count     integer NOT NULL DEFAULT 0,
    variant_count   integer NOT NULL DEFAULT 0,
    sold_out_count  integer NOT NULL DEFAULT 0,
    sold_out_median double precision,
    sales_count     integer NOT NULL DEFAULT 0,
    quick_sell      double precision,
    normal_sell     double precision,
    recommendation  jsonb,
    list_fields     text    NOT NULL DEFAULT ''
);

ALTER TABLE item_daily
    ALTER COLUMN median TYPE double precision,
    ALTER COLUMN low TYPE double precision,
    ALTER COLUMN high TYPE double precision;

-- Catalogue record served by /api/v1/items/<id> (record_json of items.sqlite).
CREATE TABLE item_records (
    item_id         integer PRIMARY KEY REFERENCES items (id),
    record          jsonb NOT NULL
);

-- One row. version is the list ETag; counters feed the report header;
-- refreshed_* say which window the last full stats refresh covered.
CREATE TABLE market_state (
    id                  boolean PRIMARY KEY DEFAULT true CHECK (id),
    version             bigint      NOT NULL DEFAULT 0,
    as_of               timestamptz,
    visits              bigint      NOT NULL DEFAULT 0,
    observation_rows    bigint      NOT NULL DEFAULT 0,
    shops               bigint      NOT NULL DEFAULT 0,
    refreshed_at        timestamptz,
    refreshed_cutoff    timestamptz,
    refreshed_as_of     timestamptz
);
INSERT INTO market_state DEFAULT VALUES;
