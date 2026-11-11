-- Derived one-to-one links only: both immutable source records remain available.
CREATE TABLE cross_source_sale_matches (
    external_sale_id bigint PRIMARY KEY REFERENCES sales(id) ON DELETE CASCADE,
    collector_sale_id bigint NOT NULL UNIQUE REFERENCES sales(id) ON DELETE CASCADE,
    item_id integer NOT NULL REFERENCES items(id),
    delta_seconds double precision NOT NULL CHECK(delta_seconds BETWEEN 0 AND 21600),
    rule text NOT NULL DEFAULT 'owner_price_6h_v1',
    matched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cross_source_sale_matches_item_idx ON cross_source_sale_matches(item_id);
CREATE INDEX sales_external_match_idx ON sales(item_id,source_seller,source_price,detected_at)
    WHERE source='mesowatch';
CREATE INDEX sales_collector_match_idx ON sales(item_id,detected_at) WHERE source='collector';

CREATE OR REPLACE VIEW market_sales AS
    SELECT s.*, COALESCE(s.source_price,market_unit_price(s.item_id,s.price,s.bundle)) AS unit_price,
           COALESCE(s.source_unit,market_price_unit(s.item_id)) AS unit_basis,
           COALESCE(s.shop_id,-s.external_shop_id) AS grouping_shop_id
    FROM sales s
    WHERE NOT EXISTS(SELECT 1 FROM cross_source_sale_matches m WHERE m.external_sale_id=s.id);
