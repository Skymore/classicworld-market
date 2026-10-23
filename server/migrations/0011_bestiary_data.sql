-- R5-D: the full item catalogue, NPC shops and NiaDB-only bestiary rows.
-- `import_catalog` writes all of these; see 0010 for the tables.

-- `name_tw` is the GMS-TW traditional name (Mapledex `zh`), as on mobs/maps.
-- `gms_id` is the GMS v83 id of the same item (Mapledex `src`); drops that
-- Mapledex lists by GMS id only resolve through it.
ALTER TABLE items
    ADD COLUMN name_tw text,
    ADD COLUMN gms_id  integer;

-- Where the price was seen (NiaDB `priceSource`: screenshots, videos, dates).
ALTER TABLE npc_shops ADD COLUMN source text;

-- Return links of the maps only NiaDB lists.
ALTER TABLE map_portals DROP CONSTRAINT map_portals_source_check;
ALTER TABLE map_portals ADD CONSTRAINT map_portals_source_check
    CHECK (source IN ('mapledex', 'wz', 'niadb'));
