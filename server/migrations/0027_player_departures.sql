-- Confirmed protocol events, never inferred from capture silence or time-to-live.
CREATE TABLE player_departures (
    collector_id bigint NOT NULL REFERENCES collectors(id),
    event_id text NOT NULL,
    world text NOT NULL CHECK (world='ClassicWorld'),
    channel smallint NOT NULL CHECK (channel BETWEEN 1 AND 255),
    room smallint NOT NULL CHECK (room BETWEEN 1 AND 22),
    character_id bigint NOT NULL CHECK (character_id BETWEEN 1 AND 4294967295),
    name text NOT NULL,
    seen_at timestamptz NOT NULL,
    observed_at timestamptz NOT NULL,
    PRIMARY KEY (collector_id,event_id),
    CHECK (observed_at >= seen_at)
);
CREATE INDEX player_departures_owner_location ON player_departures
    (world,character_id,channel,room,observed_at DESC);

-- Separate from live inventory so all existing price/alert/stat paths exclude it.
CREATE TABLE expired_listings (
    shop_id bigint NOT NULL REFERENCES shops(id),
    observation_id bigint NOT NULL REFERENCES observations(id),
    slot integer NOT NULL,
    item_id integer NOT NULL REFERENCES items(id),
    variant_id bigint REFERENCES equipment_variants(id),
    price bigint NOT NULL,
    bundle integer NOT NULL,
    stock integer NOT NULL,
    invalidated_at timestamptz NOT NULL,
    PRIMARY KEY (observation_id,slot)
);
CREATE INDEX expired_listings_item_time ON expired_listings(item_id,invalidated_at DESC);
