-- Map changes between NiaDB fetches (data/reference/niadb/map-changes.json,
-- tools/niadb_mob_changes.py): `stat` 'mob_rate' is the spawn rate (mob_id 0);
-- 'spawns' is how many spawn points `mob_id` has on the map (0: none). It went
-- from `old_value` to `new_value` some time between `since` and `seen`.
-- Rewritten by import_catalog with the maps.
CREATE TABLE map_stat_changes (
    map_id    integer          NOT NULL REFERENCES maps (id) ON DELETE CASCADE,
    stat      text             NOT NULL,
    mob_id    integer          NOT NULL DEFAULT 0,
    old_value double precision NOT NULL,
    new_value double precision NOT NULL,
    since     date             NOT NULL,
    seen      date             NOT NULL,
    PRIMARY KEY (map_id, stat, mob_id, seen)
);
