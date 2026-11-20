-- Monster stat changes between NiaDB fetches (data/reference/niadb/mob-changes.json,
-- tools/niadb_mob_changes.py): `stat` went from `old_value` to `new_value` some
-- time between `since` and `seen`. Rewritten by import_catalog with the mobs.
CREATE TABLE mob_stat_changes (
    mob_id    integer NOT NULL REFERENCES mobs (id) ON DELETE CASCADE,
    stat      text    NOT NULL,
    old_value bigint  NOT NULL,
    new_value bigint  NOT NULL,
    since     date    NOT NULL,
    seen      date    NOT NULL,
    PRIMARY KEY (mob_id, stat, seen)
);
CREATE INDEX mob_stat_changes_seen ON mob_stat_changes (seen DESC);
