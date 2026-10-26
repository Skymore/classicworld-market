-- Only protocol-delimited, contiguous map-entry rosters can establish absence.
CREATE TABLE room_rosters (
    collector_id bigint NOT NULL REFERENCES collectors(id),
    event_id text NOT NULL,
    world text NOT NULL CHECK (world='ClassicWorld'),
    channel smallint NOT NULL CHECK (channel BETWEEN 1 AND 255),
    room smallint NOT NULL CHECK (room BETWEEN 1 AND 22),
    started_at timestamptz NOT NULL,
    observed_at timestamptz NOT NULL,
    character_ids bigint[] NOT NULL,
    PRIMARY KEY (collector_id,event_id),
    CHECK (observed_at >= started_at AND observed_at <= started_at + interval '10 seconds'),
    CHECK (cardinality(character_ids) BETWEEN 1 AND 500)
);
CREATE INDEX room_rosters_place_time ON room_rosters(world,channel,room,started_at DESC);
ALTER TABLE player_departures ADD COLUMN evidence_kind text NOT NULL DEFAULT 'player_departure'
    CHECK (evidence_kind IN ('player_departure','room_roster'));
CREATE INDEX shops_presence_place ON shops(world,channel,room,owner_character_id)
    WHERE owner_character_id IS NOT NULL;
