-- Keep the provenance of withdrawn evidence outside every market query.
CREATE TABLE external_market_excluded_evidence (
    source text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('sale','listing')),
    source_key text NOT NULL,
    item_id integer NOT NULL,
    payload jsonb NOT NULL,
    reason text NOT NULL DEFAULT 'equipment_without_attributes',
    excluded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(source,kind,source_key)
);
