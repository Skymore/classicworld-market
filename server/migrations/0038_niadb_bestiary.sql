-- NiaDB is the bestiary's source for what exists in Classic World: maps,
-- spawns, mobs with their launch stats, and the drops players confirmed.
-- `import_catalog` writes all of these; see 0010 for the tables.

-- Content that is in the client but not open yet (Orbis / El Nath): kept in
-- the tables, never shown. NPCs are unreleased when every map they stand on is.
ALTER TABLE maps ADD COLUMN unreleased boolean NOT NULL DEFAULT false;
ALTER TABLE mobs ADD COLUMN unreleased boolean NOT NULL DEFAULT false;
ALTER TABLE npcs ADD COLUMN unreleased boolean NOT NULL DEFAULT false;

-- NiaDB drops have no rate (Classic World publishes none); they carry the
-- community votes instead. The existing CHECK on rate_pct passes NULL.
ALTER TABLE drops
    ALTER COLUMN rate_pct DROP NOT NULL,
    ADD COLUMN upvotes real,
    ADD COLUMN downvotes real;
