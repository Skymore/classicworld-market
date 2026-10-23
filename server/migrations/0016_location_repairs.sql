-- Keep the original upload immutable while auditing authenticated location enrichment.
CREATE TABLE observation_location_repairs (
    observation_id bigint PRIMARY KEY REFERENCES observations(id),
    collector_id bigint NOT NULL REFERENCES collectors(id),
    original_shop jsonb NOT NULL,
    channel smallint NOT NULL CHECK(channel BETWEEN 1 AND 255),
    room smallint NOT NULL CHECK(room BETWEEN 0 AND 22),
    repaired_at timestamptz NOT NULL DEFAULT now()
);
