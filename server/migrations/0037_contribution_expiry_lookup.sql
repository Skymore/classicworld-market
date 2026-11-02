-- An expired summary must probe only its device/shop. Joining the small expiry
-- set to all states let the planner hash millions of multiranges (and spill)
-- even when only a handful of shops needed an exact recount.
CREATE OR REPLACE FUNCTION contribution_shop_counts(collectors bigint[], period integer, at_time timestamptz)
RETURNS TABLE(shop_id bigint, quotes bigint) LANGUAGE sql STABLE AS $$
    WITH candidates AS MATERIALIZED (
        SELECT * FROM contribution_shop_rollups WHERE collector_id=ANY(collectors)
    ), expired AS MATERIALIZED (
        SELECT collector_id,shop_id FROM candidates
        WHERE valid_from>at_time OR valid_until<=at_time
    ), counts AS MATERIALIZED (
        SELECT collector_id,shop_id,
            CASE period WHEN 0 THEN all_quotes WHEN 7 THEN week_quotes ELSE month_quotes END AS quotes
        FROM candidates WHERE valid_from<=at_time AND (valid_until IS NULL OR valid_until>at_time)
        UNION ALL
        SELECT c.collector_id,c.shop_id,r.quotes FROM expired c
        CROSS JOIN LATERAL (
            SELECT count(*) AS quotes FROM contribution_states r
            WHERE r.collector_id=c.collector_id AND r.shop_id=c.shop_id
              AND CASE period WHEN 0 THEN r.first_seen<=at_time
                  WHEN 7 THEN r.week_windows @> at_time ELSE r.month_windows @> at_time END
            OFFSET 0
        ) r
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
