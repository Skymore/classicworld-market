-- Bestiary tables (REDESIGN_PLAN_V2 §3.2). Written only by the importers:
-- `import_catalog` (items.sqlite + Mapledex) and `import_portals` (Map.wz JSON).
-- One dataset per table at a time; a re-import replaces it. `catalog_versions`
-- records which dataset version was loaded.
--
-- Ids are Classic World ids (the client's and Mapledex's `id`). `gms_id` is
-- Mapledex `src`, the GMS v83 id of the same thing (maplestory.io renders it).
-- Name columns: `name_zh` is the Classic World simplified name (Mapledex `cw`),
-- `name_tw` the traditional GMS-TW name (Mapledex `zh`).
-- The tables are small (hundreds to a few thousand rows); search scans them.

CREATE TABLE catalog_versions (
    dataset         text        NOT NULL,                   -- items / mapledex / wz_portals
    version         text        NOT NULL,
    source          text,                                   -- file the import read
    counts          jsonb       NOT NULL DEFAULT '{}',
    imported_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (dataset, version)
);

CREATE TABLE mobs (
    id              integer PRIMARY KEY,
    gms_id          integer,
    link_id         integer,                                -- reuses this mob's graphics
    name_en         text        NOT NULL,
    name_zh         text,
    name_tw         text,
    level           smallint,
    hp              bigint,
    mp              bigint,
    exp             bigint,
    pad             integer,                                -- weapon attack
    pdd             integer,                                -- weapon defence
    mad             integer,                                -- magic attack
    mdd             integer,                                -- magic defence
    acc             integer,
    eva             integer,
    speed           integer,
    is_boss         boolean     NOT NULL DEFAULT false,
    is_undead       boolean     NOT NULL DEFAULT false,
    description     text,
    drop_source     text                                    -- Mapledex dropSrc: book / sql
);

CREATE TABLE maps (
    id              integer PRIMARY KEY,
    gms_id          integer,
    name_en         text        NOT NULL,
    name_zh         text,
    name_tw         text,
    street_en       text,
    street_zh       text,
    street_tw       text,
    description     text,
    is_town         boolean     NOT NULL DEFAULT false,
    return_map_id   integer     REFERENCES maps (id),       -- return scroll / respawn target
    mob_rate        real,
    bgm             text,
    minimap_url     text                                    -- from Map.wz, later
);

CREATE TABLE mob_spawns (
    map_id          integer     NOT NULL REFERENCES maps (id) ON DELETE CASCADE,
    mob_id          integer     NOT NULL REFERENCES mobs (id) ON DELETE CASCADE,
    spawn_count     smallint    NOT NULL,                   -- spawn points on the map
    PRIMARY KEY (map_id, mob_id)
);
CREATE INDEX mob_spawns_mob_idx ON mob_spawns (mob_id);

-- Mapledex lists drops per mob, including meso and quest-only drops. Item ids
-- may be outside `items` (the catalog only holds tradeable items), so no FK.
CREATE TABLE drops (
    mob_id          integer     NOT NULL REFERENCES mobs (id) ON DELETE CASCADE,
    ord             smallint    NOT NULL,                   -- position in the Mapledex list
    item_id         integer,                                -- Classic World item id
    gms_item_id     integer,                                -- when Mapledex only has the GMS id
    name_en         text,                                   -- Mapledex names, when given
    name_zh         text,
    name_tw         text,
    meso_min        integer,
    meso_max        integer,
    rate_pct        double precision NOT NULL CHECK (rate_pct > 0 AND rate_pct <= 100),
    quest_id        integer,                                -- only drops during this quest
    source          text,                                   -- Mapledex dropSrc
    PRIMARY KEY (mob_id, ord),
    CHECK (item_id IS NOT NULL OR gms_item_id IS NOT NULL OR meso_max IS NOT NULL)
);
CREATE INDEX drops_item_idx ON drops (item_id) WHERE item_id IS NOT NULL;

-- maps.json only gives NPC ids; names come with a later npcs.json import.
CREATE TABLE npcs (
    id              integer PRIMARY KEY,
    name_en         text,
    name_zh         text,
    name_tw         text
);

CREATE TABLE map_npcs (
    map_id          integer     NOT NULL REFERENCES maps (id) ON DELETE CASCADE,
    npc_id          integer     NOT NULL REFERENCES npcs (id) ON DELETE CASCADE,
    PRIMARY KEY (map_id, npc_id)
);
CREATE INDEX map_npcs_npc_idx ON map_npcs (npc_id);

-- What an NPC sells and for how much. Empty: Mapledex has no shop lists.
CREATE TABLE npc_shops (
    npc_id          integer     NOT NULL REFERENCES npcs (id) ON DELETE CASCADE,
    item_id         integer     NOT NULL,
    price           bigint      NOT NULL CHECK (price >= 0),
    PRIMARY KEY (npc_id, item_id)
);
CREATE INDEX npc_shops_item_idx ON npc_shops (item_id);

-- Directed edges for the route finder. No FK on the map ids: Map.wz links
-- maps that Mapledex does not list, and those are still valid route steps.
CREATE TABLE map_portals (
    id              bigserial PRIMARY KEY,
    from_map_id     integer     NOT NULL,
    to_map_id       integer     NOT NULL,
    kind            text        NOT NULL CHECK (kind IN ('portal', 'return', 'taxi', 'ship')),
    portal_name     text,                                   -- WZ `pn`
    target_portal   text,                                   -- WZ `tn`
    x               integer,
    y               integer,
    source          text        NOT NULL CHECK (source IN ('mapledex', 'wz')),
    CHECK (from_map_id <> to_map_id)
);
CREATE INDEX map_portals_from_idx ON map_portals (from_map_id);
CREATE INDEX map_portals_to_idx ON map_portals (to_map_id);

-- Empty until a source with quest data is imported.
CREATE TABLE quests (
    id              integer PRIMARY KEY,
    name_en         text,
    name_zh         text,
    name_tw         text
);

CREATE TABLE quest_rewards (
    quest_id        integer     NOT NULL REFERENCES quests (id) ON DELETE CASCADE,
    item_id         integer     NOT NULL,
    quantity        integer     NOT NULL DEFAULT 1,
    PRIMARY KEY (quest_id, item_id)
);
CREATE INDEX quest_rewards_item_idx ON quest_rewards (item_id);
