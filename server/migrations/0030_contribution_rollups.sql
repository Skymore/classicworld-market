-- Exact per-device/shop counts. Readers normally scan one narrow row per shop,
-- while overlapping devices and expired windows still use deduplicated states.
SELECT pg_advisory_xact_lock(x'63776d77'::int::bigint);

CREATE TABLE contribution_shop_rollups (
    collector_id bigint NOT NULL REFERENCES collectors(id),
    shop_id bigint NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    all_quotes bigint NOT NULL,
    week_quotes bigint NOT NULL,
    month_quotes bigint NOT NULL,
    valid_from timestamptz NOT NULL,
    valid_until timestamptz,
    PRIMARY KEY (collector_id, shop_id)
);
CREATE INDEX contribution_rollups_expiry ON contribution_shop_rollups(valid_until)
WHERE valid_until IS NOT NULL;

CREATE FUNCTION contribution_next_change(first_seen timestamptz, week_windows tstzmultirange,
    month_windows tstzmultirange, at_time timestamptz) RETURNS timestamptz
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT min(t) FROM (
        SELECT first_seen AS t
        UNION ALL
        SELECT lower(r) + CASE WHEN lower_inc(r) THEN interval '0' ELSE interval '1 microsecond' END
        FROM (SELECT unnest(week_windows) r UNION ALL SELECT unnest(month_windows)) ranges
        UNION ALL
        SELECT upper(r) + CASE WHEN upper_inc(r) THEN interval '1 microsecond' ELSE interval '0' END
        FROM unnest(week_windows) r
        UNION ALL
        SELECT upper(r) + CASE WHEN upper_inc(r) THEN interval '1 microsecond' ELSE interval '0' END
        FROM unnest(month_windows) r
    ) boundaries WHERE t > at_time;
$$;

CREATE FUNCTION refresh_contribution_rollup(collector bigint, shop bigint) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    -- Cascading shop deletion must not recreate its derived row.
    IF NOT EXISTS (SELECT 1 FROM shops WHERE id=shop) THEN
        DELETE FROM contribution_shop_rollups WHERE collector_id=collector AND shop_id=shop;
        RETURN;
    END IF;
    INSERT INTO contribution_shop_rollups
    SELECT collector,shop,count(*) FILTER (WHERE first_seen<=now()),
        count(*) FILTER (WHERE week_windows @> now()),count(*) FILTER (WHERE month_windows @> now()),
        now(),min(contribution_next_change(first_seen,week_windows,month_windows,now()))
    FROM contribution_states WHERE collector_id=collector AND shop_id=shop
    ON CONFLICT (collector_id,shop_id) DO UPDATE SET
        all_quotes=excluded.all_quotes,week_quotes=excluded.week_quotes,month_quotes=excluded.month_quotes,
        valid_from=excluded.valid_from,valid_until=excluded.valid_until;
END;
$$;

CREATE FUNCTION refresh_changed_contribution_shops() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed record;
BEGIN
    FOR changed IN SELECT DISTINCT collector_id,shop_id FROM changed_states ORDER BY collector_id,shop_id LOOP
        PERFORM refresh_contribution_rollup(changed.collector_id,changed.shop_id);
    END LOOP;
    RETURN NULL;
END;
$$;
CREATE TRIGGER contribution_rollups_inserted AFTER INSERT ON contribution_states
REFERENCING NEW TABLE AS changed_states FOR EACH STATEMENT EXECUTE FUNCTION refresh_changed_contribution_shops();
CREATE TRIGGER contribution_rollups_updated AFTER UPDATE ON contribution_states
REFERENCING NEW TABLE AS changed_states FOR EACH STATEMENT EXECUTE FUNCTION refresh_changed_contribution_shops();
CREATE TRIGGER contribution_rollups_deleted AFTER DELETE ON contribution_states
REFERENCING OLD TABLE AS changed_states FOR EACH STATEMENT EXECUTE FUNCTION refresh_changed_contribution_shops();

INSERT INTO contribution_shop_rollups
SELECT collector_id,shop_id,count(*) FILTER (WHERE first_seen<=now()),
    count(*) FILTER (WHERE week_windows @> now()),count(*) FILTER (WHERE month_windows @> now()),
    now(),min(contribution_next_change(first_seen,week_windows,month_windows,now()))
FROM contribution_states GROUP BY collector_id,shop_id;
ANALYZE contribution_shop_rollups;

CREATE FUNCTION contribution_shop_counts(collectors bigint[], period integer, at_time timestamptz)
RETURNS TABLE(shop_id bigint, quotes bigint) LANGUAGE sql STABLE AS $$
    WITH candidates AS MATERIALIZED (
        SELECT * FROM contribution_shop_rollups WHERE collector_id=ANY(collectors)
    ), counts AS MATERIALIZED (
        SELECT collector_id,shop_id,
            CASE period WHEN 0 THEN all_quotes WHEN 7 THEN week_quotes ELSE month_quotes END AS quotes
        FROM candidates WHERE valid_from<=at_time AND (valid_until IS NULL OR valid_until>at_time)
        UNION ALL
        SELECT r.collector_id,r.shop_id,count(*) FROM candidates c
        JOIN contribution_states r USING(collector_id,shop_id)
        WHERE (c.valid_from>at_time OR c.valid_until<=at_time)
          AND CASE period WHEN 0 THEN r.first_seen<=at_time
              WHEN 7 THEN r.week_windows @> at_time ELSE r.month_windows @> at_time END
        GROUP BY r.collector_id,r.shop_id
    ), shops AS MATERIALIZED (
        SELECT shop_id,sum(quotes)::bigint quotes,count(*) devices
        FROM counts WHERE quotes>0 GROUP BY shop_id
    )
    SELECT shop_id,quotes FROM shops WHERE devices=1
    UNION ALL
    SELECT s.shop_id,count(*) FROM shops s
    CROSS JOIN LATERAL (
        SELECT DISTINCT r.slot,r.item_id,r.variant_id,r.price,r.bundle,r.stock
        FROM contribution_states r WHERE r.shop_id=s.shop_id AND r.collector_id=ANY(collectors)
          AND CASE period WHEN 0 THEN r.first_seen<=at_time
              WHEN 7 THEN r.week_windows @> at_time ELSE r.month_windows @> at_time END
    ) states WHERE s.devices>1 GROUP BY s.shop_id;
$$;
