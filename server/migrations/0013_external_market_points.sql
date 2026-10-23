-- Both collectors and authorized external exports contribute evidence points.
-- An external event is not a complete collector observation. Keep absent facts NULL.
CREATE TABLE external_market_imports (
    source text NOT NULL,
    fingerprint text NOT NULL,
    source_generated_at timestamptz NOT NULL,
    imported_at timestamptz NOT NULL DEFAULT now(),
    manifest jsonb NOT NULL,
    PRIMARY KEY (source, fingerprint)
);
CREATE TABLE external_market_shops (
    id bigserial PRIMARY KEY,
    source text NOT NULL,
    source_key text NOT NULL,
    UNIQUE (source, source_key)
);
ALTER TABLE sales
    ALTER COLUMN shop_id DROP NOT NULL,
    ALTER COLUMN slot DROP NOT NULL,
    ALTER COLUMN price DROP NOT NULL,
    ALTER COLUMN bundle DROP NOT NULL,
    ALTER COLUMN observation_id DROP NOT NULL,
    ALTER COLUMN position DROP NOT NULL,
    ADD COLUMN source text NOT NULL DEFAULT 'collector',
    ADD COLUMN source_key text,
    ADD COLUMN source_price double precision,
    ADD COLUMN source_unit text,
    ADD COLUMN source_seller text,
    ADD COLUMN source_location jsonb,
    ADD COLUMN source_payload jsonb,
    ADD COLUMN external_shop_id bigint REFERENCES external_market_shops(id),
    ADD CONSTRAINT sales_source_check CHECK (source IN ('collector', 'mesowatch')),
    ADD CONSTRAINT sales_evidence_check CHECK (
      (source='collector' AND shop_id IS NOT NULL AND slot IS NOT NULL AND price IS NOT NULL
       AND bundle IS NOT NULL AND bundle>0 AND observation_id IS NOT NULL AND position IS NOT NULL
       AND source_key IS NULL AND source_price IS NULL)
      OR (source='mesowatch' AND source_key IS NOT NULL AND source_price IS NOT NULL AND source_price>0
       AND source_price<'Infinity'::float8 AND source_unit IS NOT NULL AND source_unit IN ('item','set')
       AND external_shop_id IS NOT NULL AND source_payload IS NOT NULL
       AND shop_id IS NULL AND observation_id IS NULL AND slot IS NULL
       AND price IS NULL AND bundle IS NULL AND quantity IS NULL AND position IS NULL)
    );
CREATE UNIQUE INDEX sales_source_key_idx ON sales(source, source_key) WHERE source_key IS NOT NULL;

CREATE TABLE external_market_listings (
    source text NOT NULL,
    source_key text NOT NULL,
    source_item_id text NOT NULL,
    item_id int NOT NULL REFERENCES items(id),
    external_shop_id bigint NOT NULL REFERENCES external_market_shops(id),
    unit_price double precision NOT NULL CHECK (unit_price>0 AND unit_price<'Infinity'::float8),
    unit_basis text NOT NULL CHECK (unit_basis IN ('item','set')),
    seller text,
    location jsonb,
    seen_at timestamptz NOT NULL,
    source_generated_at timestamptz NOT NULL,
    up boolean NOT NULL,
    raw jsonb NOT NULL,
    PRIMARY KEY (source,source_key)
);
CREATE INDEX external_market_listings_item_idx ON external_market_listings(item_id,seen_at);

-- Throwing stars are traded per set. Other items retain per-item prices.
-- Preserve price/bundle themselves; this only defines their comparable unit.
CREATE FUNCTION market_price_unit(i int) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT CASE WHEN i/10000=207 THEN 'set' ELSE 'item' END
$$;
CREATE FUNCTION market_unit_price(i int, p bigint, b int) RETURNS double precision
LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT CASE WHEN i/10000=207 THEN p::float8 ELSE p::float8/NULLIF(b,0) END
$$;
CREATE VIEW market_sales AS
    SELECT s.*, COALESCE(s.source_price,market_unit_price(s.item_id,s.price,s.bundle)) AS unit_price,
           COALESCE(s.source_unit,market_price_unit(s.item_id)) AS unit_basis,
           COALESCE(s.shop_id,-s.external_shop_id) AS grouping_shop_id
    FROM sales s;
