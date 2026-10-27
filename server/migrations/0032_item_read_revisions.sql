-- A public item snapshot depends on its items, not every upload in the market.
-- Keep revisions in the same transaction as statistics. The trigger also
-- covers older binaries during rollback and full/background recomputations.
SELECT pg_advisory_xact_lock(x'63776d77'::int::bigint);

CREATE SEQUENCE item_read_revision_seq;
ALTER TABLE item_stats ADD COLUMN read_revision bigint NOT NULL DEFAULT nextval('item_read_revision_seq');
ALTER SEQUENCE item_read_revision_seq OWNED BY item_stats.read_revision;

CREATE FUNCTION advance_item_read_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.read_revision := nextval('item_read_revision_seq');
    RETURN NEW;
END;
$$;
CREATE TRIGGER item_read_revision_updated BEFORE UPDATE ON item_stats
FOR EACH ROW EXECUTE FUNCTION advance_item_read_revision();
