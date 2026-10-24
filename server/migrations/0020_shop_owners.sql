-- Shop instances keep their original identity/location. A stable host identity
-- decides which instance supplies current listings, without rewriting history.
ALTER TABLE shops ADD COLUMN owner_character_id bigint CHECK(owner_character_id BETWEEN 1 AND 4294967295);
ALTER TABLE shops ADD COLUMN owner_name text;
CREATE INDEX shops_owner_idx ON shops(world, owner_character_id) WHERE owner_character_id IS NOT NULL;
CREATE TABLE observation_shop_owners (
    observation_id bigint PRIMARY KEY REFERENCES observations(id),
    character_id bigint NOT NULL CHECK(character_id BETWEEN 1 AND 4294967295),
    name text NOT NULL,
    parser text NOT NULL CHECK(parser='cw_shop_owner_v1'),
    enriched_at timestamptz NOT NULL DEFAULT now()
);
