-- The run a client has open right now, pushed every few seconds so the
-- account's grind page can follow it live. One row per client; an empty push
-- deletes it, and readers ignore rows not refreshed within 90 seconds.
CREATE TABLE grind_live (
    collector_id    bigint      PRIMARY KEY REFERENCES collectors (id) ON DELETE CASCADE,
    runs            jsonb       NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now()
);
