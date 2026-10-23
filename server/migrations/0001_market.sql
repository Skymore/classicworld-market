-- Market tables (REDESIGN_PLAN_V2 §3.1). Bestiary tables come with R3.
-- Times are timestamptz. Prices are mesos as bigint.

CREATE TABLE collectors (
    id              bigserial PRIMARY KEY,
    public_id       text        NOT NULL UNIQUE,            -- stable id the client sends
    token_hash      bytea       NOT NULL,                   -- sha256 of the bearer token
    source          text        NOT NULL CHECK (source IN ('packet', 'screen')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz
);

CREATE TABLE items (
    id              integer PRIMARY KEY,                     -- game item id
    name_en         text        NOT NULL,
    name_zh         text,
    category        text        NOT NULL,                   -- 装备 / 消耗 / 其他 / 商城
    subcategory     text,
    req_level       smallint,
    req_job_mask    smallint,
    icon_url        text,
    is_cash         boolean     NOT NULL DEFAULT false
);

CREATE TABLE shops (
    id              bigserial PRIMARY KEY,
    shop_key        text        NOT NULL UNIQUE,            -- market_core::ShopIdentity::key()
    world           text        NOT NULL,
    channel         smallint,
    room            smallint,
    shop_id         integer     NOT NULL,
    title           text        NOT NULL,
    first_seen_at   timestamptz NOT NULL,
    last_seen_at    timestamptz NOT NULL
);
CREATE INDEX shops_last_seen_idx ON shops (last_seen_at);

CREATE TABLE observations (
    id              bigserial PRIMARY KEY,
    observation_id  text        NOT NULL,                   -- client-generated, unique per collector
    collector_id    bigint      NOT NULL REFERENCES collectors (id),
    shop_id         bigint      NOT NULL REFERENCES shops (id),
    source          text        NOT NULL CHECK (source IN ('packet', 'screen')),
    reader_version  text,
    observed_at     timestamptz NOT NULL,
    received_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (collector_id, observation_id)
);
CREATE INDEX observations_shop_time_idx ON observations (shop_id, observed_at);

CREATE TABLE equipment_variants (
    id              bigserial PRIMARY KEY,
    item_id         integer     NOT NULL REFERENCES items (id),
    stats_hash      bytea       NOT NULL,                   -- sha256 of the canonical stats JSON
    stats           jsonb       NOT NULL,                   -- str/dex/int/luk/watk/matk/..., upgrades left
    UNIQUE (item_id, stats_hash)
);

CREATE TABLE observation_rows (
    observation_id  bigint      NOT NULL REFERENCES observations (id) ON DELETE CASCADE,
    slot            smallint    NOT NULL,                   -- position in the shop window
    item_id         integer     NOT NULL REFERENCES items (id),
    variant_id      bigint      REFERENCES equipment_variants (id),
    unit_price      bigint      NOT NULL CHECK (unit_price > 0),
    bundle          smallint    NOT NULL DEFAULT 1,         -- items per purchase
    stock           integer     NOT NULL CHECK (stock >= 0),-- bundles left; 0 = sold out
    confidence      real,                                   -- screen reader only
    PRIMARY KEY (observation_id, slot)
);
CREATE INDEX observation_rows_item_idx ON observation_rows (item_id);

-- Current state of every shop row, derived by replaying that shop's observations.
CREATE TABLE listings (
    shop_id         bigint      NOT NULL REFERENCES shops (id),
    slot            smallint    NOT NULL,
    item_id         integer     NOT NULL REFERENCES items (id),
    variant_id      bigint      REFERENCES equipment_variants (id),
    unit_price      bigint      NOT NULL,
    bundle          smallint    NOT NULL,
    stock           integer     NOT NULL,
    first_seen_at   timestamptz NOT NULL,
    last_seen_at    timestamptz NOT NULL,
    PRIMARY KEY (shop_id, slot)
);
CREATE INDEX listings_item_price_idx ON listings (item_id, unit_price) WHERE stock > 0;

CREATE TABLE sales (
    id              bigserial PRIMARY KEY,
    item_id         integer     NOT NULL REFERENCES items (id),
    variant_id      bigint      REFERENCES equipment_variants (id),
    shop_id         bigint      NOT NULL REFERENCES shops (id),
    slot            smallint    NOT NULL,
    kind            text        NOT NULL CHECK (kind IN ('drop', 'sold_out', 'found_sold')),
    unit_price      bigint      NOT NULL,
    quantity        integer,                                -- bundles sold; NULL when unknown (found_sold)
    window_start    timestamptz,                            -- previous observation of this row; NULL for found_sold
    detected_at     timestamptz NOT NULL,                   -- observation that showed the change
    observation_id  bigint      NOT NULL REFERENCES observations (id),
    UNIQUE (observation_id, slot)
);
CREATE INDEX sales_item_time_idx ON sales (item_id, detected_at DESC);
CREATE INDEX sales_time_idx ON sales (detected_at DESC);

-- Precomputed per item, rewritten for the items touched by each upload.
CREATE TABLE item_stats (
    item_id         integer PRIMARY KEY REFERENCES items (id),
    typical         bigint,                                 -- median sale price of the sample window
    typical_low     bigint,
    typical_high    bigint,
    sample_size     integer     NOT NULL DEFAULT 0,
    sales_24h       integer     NOT NULL DEFAULT 0,
    change_24h      real,                                   -- percent vs the previous 24h
    lowest_ask      bigint,
    listings_count  integer     NOT NULL DEFAULT 0,
    shops_count     integer     NOT NULL DEFAULT 0,
    quick_sell      bigint,
    normal_sell     bigint,
    last_sale_at    timestamptz,
    as_of           timestamptz NOT NULL
);
CREATE INDEX item_stats_sales_24h_idx ON item_stats (sales_24h DESC);

CREATE TABLE item_daily (
    item_id         integer     NOT NULL REFERENCES items (id),
    day             date        NOT NULL,
    median          bigint,
    low             bigint,
    high            bigint,
    count           integer     NOT NULL,
    PRIMARY KEY (item_id, day)
);

-- Raw uploads, compressed. Audit and re-ingest only; never read on request paths.
CREATE TABLE uploads_raw (
    id              bigserial PRIMARY KEY,
    collector_id    bigint      NOT NULL REFERENCES collectors (id),
    observation_id  text        NOT NULL,
    received_at     timestamptz NOT NULL DEFAULT now(),
    body            bytea       NOT NULL,                   -- gzip of the JSON body
    UNIQUE (collector_id, observation_id)
);
