-- What the map view draws over the minimap (NiaDB maps.json). `import_catalog`
-- writes all of these.

-- The minimap rectangle in world units: a point (x, y) of the map is at
-- (x + minimap_cx, y + minimap_cy) inside a minimap_w x minimap_h box. The
-- image (`minimap_url`) is that box at 1/16. `spawn_x/y`: where a player
-- enters the map without a portal (first player spawn point).
ALTER TABLE maps
    ADD COLUMN minimap_w  integer CHECK (minimap_w > 0),
    ADD COLUMN minimap_h  integer CHECK (minimap_h > 0),
    ADD COLUMN minimap_cx integer,
    ADD COLUMN minimap_cy integer,
    ADD COLUMN spawn_x    integer,
    ADD COLUMN spawn_y    integer;

-- One row per monster spawn point; `mob_spawns` keeps the per-map totals.
-- `mob_time`: seconds before a killed monster comes back when the map sets one
-- (bosses), 0 for the normal wave respawn.
CREATE TABLE map_spawn_points (
    map_id   integer  NOT NULL REFERENCES maps (id) ON DELETE CASCADE,
    ord      smallint NOT NULL,
    mob_id   integer  NOT NULL,
    x        integer  NOT NULL,
    y        integer  NOT NULL,
    mob_time integer  NOT NULL DEFAULT 0 CHECK (mob_time >= 0),
    PRIMARY KEY (map_id, ord)
);

-- Where the NPC stands on the map, when known.
ALTER TABLE map_npcs
    ADD COLUMN x integer,
    ADD COLUMN y integer;
