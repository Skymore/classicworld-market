-- Grind tracker summaries uploaded by collectors: one row per run, one per
-- map segment. No character names or inventories are stored.
CREATE TABLE grind_sessions (
    id              bigserial   PRIMARY KEY,
    collector_id    bigint      NOT NULL REFERENCES collectors (id),
    event_id        text        NOT NULL,
    started_at      timestamptz NOT NULL,
    ended_at        timestamptz NOT NULL,
    received_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (collector_id, event_id)
);

CREATE TABLE grind_segments (
    session_id      bigint      NOT NULL REFERENCES grind_sessions (id) ON DELETE CASCADE,
    idx             smallint    NOT NULL,
    map_id          integer     NOT NULL,
    job             integer,
    level           smallint,
    active_seconds  integer     NOT NULL CHECK (active_seconds > 0),
    exp             bigint      NOT NULL,
    kills           integer     NOT NULL,
    kills_estimated boolean     NOT NULL,
    mesos           bigint      NOT NULL,
    item_value      bigint      NOT NULL,
    consume_cost    bigint      NOT NULL,
    PRIMARY KEY (session_id, idx)
);
CREATE INDEX grind_segments_map_idx ON grind_segments (map_id, level);

CREATE TABLE grind_drops (
    session_id      bigint      NOT NULL,
    idx             smallint    NOT NULL,
    item_id         integer     NOT NULL,
    quantity        integer     NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (session_id, idx, item_id),
    FOREIGN KEY (session_id, idx) REFERENCES grind_segments (session_id, idx) ON DELETE CASCADE
);
CREATE INDEX grind_drops_item_idx ON grind_drops (item_id);

CREATE TABLE grind_mobs (
    session_id      bigint      NOT NULL,
    idx             smallint    NOT NULL,
    mob_id          integer     NOT NULL,
    kills           integer     NOT NULL CHECK (kills > 0),
    PRIMARY KEY (session_id, idx, mob_id),
    FOREIGN KEY (session_id, idx) REFERENCES grind_segments (session_id, idx) ON DELETE CASCADE
);
