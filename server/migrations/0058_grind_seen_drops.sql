-- Map drop rates count the whole party: every mob the uploader or a party
-- member killed on the map, and every item that fell from those, picked up or
-- not. NULL on segments from clients that only counted their own pickups.
ALTER TABLE grind_segments ADD COLUMN seen_kills integer CHECK (seen_kills >= 0);

CREATE TABLE grind_seen_drops (
    session_id      bigint      NOT NULL,
    idx             smallint    NOT NULL,
    item_id         integer     NOT NULL,
    quantity        integer     NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (session_id, idx, item_id),
    FOREIGN KEY (session_id, idx) REFERENCES grind_segments (session_id, idx) ON DELETE CASCADE
);
