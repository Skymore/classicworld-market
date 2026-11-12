-- Links to one open run (/grind/watch/<code>): the code is the password, and
-- the link shows the run only while its client keeps pushing it.
CREATE TABLE grind_live_shares (
    code            text        PRIMARY KEY,
    collector_id    bigint      NOT NULL REFERENCES collectors (id) ON DELETE CASCADE,
    run_id          text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (collector_id, run_id)
);
