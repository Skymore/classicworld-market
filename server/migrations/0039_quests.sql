-- Quests as an item source and an item / monster demand (NiaDB quests.json,
-- simplified names and NPC ids from DVG). `import_catalog` writes all of these;
-- the tables are from 0010.

-- `unreleased`: the quest belongs to an area that is not open yet, or its NPC
-- only stands on unreleased maps. Event quests carry their dates and are shown
-- only between them.
ALTER TABLE quests
    ADD COLUMN npc_id     integer,
    ADD COLUMN level_min  smallint,
    ADD COLUMN repeats    text CHECK (repeats IN ('daily', 'weekly')),
    ADD COLUMN starts_at  timestamptz,
    ADD COLUMN ends_at    timestamptz,
    ADD COLUMN unreleased boolean NOT NULL DEFAULT false;

-- `fixed` rewards everyone gets (`job` set when only one job or gender gets
-- it), `choice` rewards the player picks one of (per `job`), `random` rewards
-- one of which is drawn with `chance_pct`.
ALTER TABLE quest_rewards
    ADD COLUMN kind       text NOT NULL DEFAULT 'fixed' CHECK (kind IN ('fixed', 'choice', 'random')),
    ADD COLUMN job        text,
    ADD COLUMN chance_pct real;

-- What a quest asks for: items to bring or monsters to defeat.
CREATE TABLE quest_needs (
    quest_id integer  NOT NULL REFERENCES quests (id) ON DELETE CASCADE,
    ord      smallint NOT NULL,
    item_id  integer,
    mob_id   integer,
    quantity integer  NOT NULL CHECK (quantity >= 0),
    PRIMARY KEY (quest_id, ord),
    CHECK ((item_id IS NULL) <> (mob_id IS NULL))
);
CREATE INDEX quest_needs_item_idx ON quest_needs (item_id) WHERE item_id IS NOT NULL;
CREATE INDEX quest_needs_mob_idx ON quest_needs (mob_id) WHERE mob_id IS NOT NULL;
