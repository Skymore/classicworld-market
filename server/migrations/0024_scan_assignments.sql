-- One whole room per lease. Tokens fence delayed workers after reassignment.
CREATE TABLE scan_workers (
    collector_id bigint PRIMARY KEY REFERENCES collectors(id),
    session_id text NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE TABLE scan_rooms (
    room smallint PRIMARY KEY CHECK (room BETWEEN 1 AND 20),
    enabled boolean NOT NULL DEFAULT true,
    last_completed timestamptz,
    collector_id bigint REFERENCES collectors(id),
    session_id text,
    lease_id text,
    expires_at timestamptz,
    channel smallint CHECK (channel BETWEEN 1 AND 40),
    CHECK ((lease_id IS NULL) = (collector_id IS NULL))
);
INSERT INTO scan_rooms(room) SELECT generate_series(1,20);
CREATE UNIQUE INDEX scan_one_room_per_collector ON scan_rooms(collector_id)
    WHERE collector_id IS NOT NULL;
