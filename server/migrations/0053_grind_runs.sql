-- Whole grind runs a client synced (its account sees them on the site) and
-- public share links. Runs belong to the client that uploaded them; the
-- account is resolved through collectors.account_id at read time.
CREATE TABLE grind_runs (
    id              bigserial   PRIMARY KEY,
    collector_id    bigint      NOT NULL REFERENCES collectors (id),
    run_id          text        NOT NULL,
    started_at      timestamptz NOT NULL,
    ended_at        timestamptz NOT NULL,
    map_id          integer,
    level           smallint,
    job             integer,
    active_seconds  integer     NOT NULL,
    exp             bigint      NOT NULL,
    net             bigint      NOT NULL,
    kills           integer     NOT NULL,
    summary         jsonb       NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (collector_id, run_id)
);
CREATE INDEX grind_runs_collector_time_idx ON grind_runs (collector_id, started_at DESC);

CREATE TABLE grind_shares (
    code            text        PRIMARY KEY CHECK (code ~ '^[A-Za-z0-9]{7}$'),
    run             bigint      NOT NULL REFERENCES grind_runs (id) ON DELETE CASCADE,
    show_name       boolean     NOT NULL,
    show_profit     boolean     NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    views           integer     NOT NULL DEFAULT 0,
    UNIQUE (run, show_name, show_profit)
);
