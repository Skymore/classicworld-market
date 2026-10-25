-- Compact contribution read model. A repeated quote extends its eligibility
-- windows instead of making every reader deduplicate the observation history.
-- Multiranges preserve gaps, rolling-window boundaries and future timestamps.
-- Same lock as stats::WRITE_LOCK: install hooks/backfill between complete
-- uploads, without taking table locks in the opposite order to an old writer.
SELECT pg_advisory_xact_lock(x'63776d77'::int::bigint);
CREATE TABLE contribution_states (
    collector_id bigint NOT NULL REFERENCES collectors(id),
    shop_id bigint NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    slot integer NOT NULL,
    item_id integer NOT NULL,
    variant_id bigint NOT NULL, -- 0 represents the absence of equipment stats
    price bigint NOT NULL,
    bundle integer NOT NULL,
    stock integer NOT NULL,
    first_seen timestamptz NOT NULL,
    week_windows tstzmultirange NOT NULL,
    month_windows tstzmultirange NOT NULL,
    PRIMARY KEY (collector_id,shop_id,slot,item_id,variant_id,price,bundle,stock)
);
CREATE TABLE contribution_days (
    collector_id bigint NOT NULL REFERENCES collectors(id),
    day date NOT NULL,
    first_seen timestamptz NOT NULL,
    week_windows tstzmultirange NOT NULL,
    month_windows tstzmultirange NOT NULL,
    PRIMARY KEY (collector_id,day)
);

-- Run inside the upload transaction, before its version bump and NOTIFY.
CREATE FUNCTION record_contribution(observation bigint) RETURNS void
LANGUAGE sql SET timezone='UTC' AS $$
    INSERT INTO contribution_states
    SELECT o.collector_id,o.shop_id,r.slot,r.item_id,coalesce(r.variant_id,0),
           r.price,r.bundle,r.stock,o.observed_at,
           tstzmultirange(tstzrange(o.observed_at,o.observed_at+interval '7 days','[]')),
           tstzmultirange(tstzrange(o.observed_at,o.observed_at+interval '30 days','[]'))
    FROM observations o JOIN observation_rows r ON r.observation_id=o.id
    WHERE o.id=observation
    ON CONFLICT (collector_id,shop_id,slot,item_id,variant_id,price,bundle,stock)
    DO UPDATE SET first_seen=least(contribution_states.first_seen,excluded.first_seen),
        week_windows=contribution_states.week_windows+excluded.week_windows,
        month_windows=contribution_states.month_windows+excluded.month_windows;

    INSERT INTO contribution_days
    SELECT o.collector_id,(o.observed_at AT TIME ZONE 'UTC')::date,o.observed_at,
           tstzmultirange(tstzrange(o.observed_at,o.observed_at+interval '7 days','[]')),
           tstzmultirange(tstzrange(o.observed_at,o.observed_at+interval '30 days','[]'))
    FROM observations o WHERE o.id=observation
      AND EXISTS(SELECT 1 FROM observation_rows r WHERE r.observation_id=o.id)
    ON CONFLICT (collector_id,day) DO UPDATE
    SET first_seen=least(contribution_days.first_seen,excluded.first_seen),
        week_windows=contribution_days.week_windows+excluded.week_windows,
        month_windows=contribution_days.month_windows+excluded.month_windows;
$$;

-- A location repair moves an observation between shop identities. Rebuild just
-- those two shops; the collector/day and timestamp are unchanged.
CREATE FUNCTION rebuild_contribution_shop(collector bigint,shop bigint) RETURNS void
LANGUAGE sql SET timezone='UTC' AS $$
    DELETE FROM contribution_states WHERE collector_id=collector AND shop_id=shop;
    INSERT INTO contribution_states
    SELECT o.collector_id,o.shop_id,r.slot,r.item_id,coalesce(r.variant_id,0),
           r.price,r.bundle,r.stock,min(o.observed_at),
           range_agg(tstzrange(o.observed_at,o.observed_at+interval '7 days','[]')),
           range_agg(tstzrange(o.observed_at,o.observed_at+interval '30 days','[]'))
    FROM observations o JOIN observation_rows r ON r.observation_id=o.id
    WHERE o.collector_id=collector AND o.shop_id=shop
    GROUP BY o.collector_id,o.shop_id,r.slot,r.item_id,coalesce(r.variant_id,0),r.price,r.bundle,r.stock;
$$;

-- Database hooks also cover uploads from the still-running old binary during
-- deployment. Creating them before backfill serializes the snapshot with writes.
CREATE FUNCTION record_inserted_contributions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE observation bigint;
BEGIN
    FOR observation IN SELECT DISTINCT observation_id FROM inserted_rows LOOP
        PERFORM record_contribution(observation);
    END LOOP;
    RETURN NULL;
END;
$$;
CREATE TRIGGER contribution_rows_inserted AFTER INSERT ON observation_rows
REFERENCING NEW TABLE AS inserted_rows FOR EACH STATEMENT
EXECUTE FUNCTION record_inserted_contributions();

CREATE FUNCTION move_contribution_shop() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.shop_id IS DISTINCT FROM NEW.shop_id THEN
        PERFORM rebuild_contribution_shop(OLD.collector_id,OLD.shop_id);
        PERFORM rebuild_contribution_shop(NEW.collector_id,NEW.shop_id);
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER contribution_shop_moved AFTER UPDATE OF shop_id ON observations
FOR EACH ROW EXECUTE FUNCTION move_contribution_shop();

-- Existing contributors keep their exact counts after deployment.
SET LOCAL timezone='UTC';
INSERT INTO contribution_states
SELECT o.collector_id,o.shop_id,r.slot,r.item_id,coalesce(r.variant_id,0),
       r.price,r.bundle,r.stock,min(o.observed_at),
       range_agg(tstzrange(o.observed_at,o.observed_at+interval '7 days','[]')),
       range_agg(tstzrange(o.observed_at,o.observed_at+interval '30 days','[]'))
FROM observations o JOIN observation_rows r ON r.observation_id=o.id
GROUP BY o.collector_id,o.shop_id,r.slot,r.item_id,coalesce(r.variant_id,0),r.price,r.bundle,r.stock;
INSERT INTO contribution_days
SELECT o.collector_id,(o.observed_at AT TIME ZONE 'UTC')::date,min(o.observed_at),
       range_agg(tstzrange(o.observed_at,o.observed_at+interval '7 days','[]')),
       range_agg(tstzrange(o.observed_at,o.observed_at+interval '30 days','[]'))
FROM observations o WHERE EXISTS(SELECT 1 FROM observation_rows r WHERE r.observation_id=o.id)
GROUP BY o.collector_id,(o.observed_at AT TIME ZONE 'UTC')::date;
ANALYZE contribution_states;
ANALYZE contribution_days;
