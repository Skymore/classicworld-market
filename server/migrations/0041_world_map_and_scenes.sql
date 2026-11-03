-- The client's world map (WorldMap.wz via NiaDB): one picture per region and
-- the spots on it, each with its marker type and the maps it covers.
-- `import_catalog` writes all three tables.

CREATE TABLE world_regions (
    id        text     PRIMARY KEY,
    ord       smallint NOT NULL,
    image_url text     NOT NULL,
    width     integer  NOT NULL CHECK (width > 0),
    height    integer  NOT NULL CHECK (height > 0)
);

-- `x`, `y`: the marker's centre in the region picture's pixels. `kind`: 0
-- town, 1 spot, 2 cluster (a dungeon's many maps), 3 field, 4 facility.
-- `map_id`: the map the spot is named after and links to.
CREATE TABLE world_spots (
    key       text     PRIMARY KEY,
    region_id text     NOT NULL REFERENCES world_regions (id) ON DELETE CASCADE,
    ord       smallint NOT NULL,
    x         integer  NOT NULL,
    y         integer  NOT NULL,
    kind      smallint NOT NULL CHECK (kind BETWEEN 0 AND 4),
    title_en  text     NOT NULL,
    map_id    integer  NOT NULL
);

CREATE TABLE world_spot_maps (
    spot_key text    NOT NULL REFERENCES world_spots (key) ON DELETE CASCADE,
    map_id   integer NOT NULL,
    PRIMARY KEY (spot_key, map_id)
);
CREATE INDEX world_spot_maps_map_idx ON world_spot_maps (map_id);

-- The rendered map scene (NiaDB, the whole map drawn from the client without
-- monsters or NPCs): its picture and the world rectangle it covers. The map
-- view draws it under the markers instead of the minimap.
ALTER TABLE maps
    ADD COLUMN scene_url text,
    ADD COLUMN scene_x   integer,
    ADD COLUMN scene_y   integer,
    ADD COLUMN scene_w   integer CHECK (scene_w > 0),
    ADD COLUMN scene_h   integer CHECK (scene_h > 0);
