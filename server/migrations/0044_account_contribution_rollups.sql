-- Merge linked devices when a shop changes, rather than repeating all of that
-- account's historical deduplication on every profile request. Raw device states
-- remain authoritative; only the derived all-time read model is added here.
SELECT pg_advisory_xact_lock(x'63776d77'::int::bigint);
SET LOCAL work_mem='32MB';

CREATE TABLE contribution_account_shops (
    account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    active_only boolean NOT NULL,
    shop_id bigint NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    quotes bigint NOT NULL,
    valid_from timestamptz NOT NULL,
    valid_until timestamptz,
    PRIMARY KEY (account_id, active_only, shop_id)
);

CREATE FUNCTION refresh_account_contribution_shop(owner bigint, shop bigint) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM shops WHERE id=shop) THEN
        DELETE FROM contribution_account_shops WHERE account_id=owner AND shop_id=shop;
        RETURN;
    END IF;
    INSERT INTO contribution_account_shops
    WITH states AS MATERIALIZED (
        SELECT c.active,r.* FROM collectors c
        CROSS JOIN LATERAL (
            SELECT r.slot,r.item_id,r.variant_id,r.price,r.bundle,r.stock,r.first_seen
            FROM contribution_states r
            WHERE r.collector_id=c.id AND r.shop_id=shop OFFSET 0
        ) r WHERE c.account_id=owner
    )
    SELECT owner,scope.active_only,shop,
        count(DISTINCT (s.slot,s.item_id,s.variant_id,s.price,s.bundle,s.stock))
            FILTER (WHERE s.first_seen<=now()),
        now(),min(s.first_seen) FILTER (WHERE s.first_seen>now())
    FROM (VALUES(false),(true)) scope(active_only)
    LEFT JOIN states s ON NOT scope.active_only OR s.active
    GROUP BY scope.active_only
    ON CONFLICT (account_id,active_only,shop_id) DO UPDATE SET
        quotes=excluded.quotes,valid_from=excluded.valid_from,valid_until=excluded.valid_until;
END;
$$;

CREATE FUNCTION refresh_changed_account_contributions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed record;
BEGIN
    FOR changed IN
        SELECT DISTINCT c.account_id,s.shop_id FROM changed_states s
        JOIN collectors c ON c.id=s.collector_id WHERE c.account_id IS NOT NULL
        ORDER BY c.account_id,s.shop_id
    LOOP
        PERFORM refresh_account_contribution_shop(changed.account_id,changed.shop_id);
    END LOOP;
    RETURN NULL;
END;
$$;
CREATE TRIGGER account_contributions_inserted AFTER INSERT ON contribution_states
REFERENCING NEW TABLE AS changed_states FOR EACH STATEMENT EXECUTE FUNCTION refresh_changed_account_contributions();
CREATE TRIGGER account_contributions_updated AFTER UPDATE ON contribution_states
REFERENCING NEW TABLE AS changed_states FOR EACH STATEMENT EXECUTE FUNCTION refresh_changed_account_contributions();
CREATE TRIGGER account_contributions_moved AFTER UPDATE ON contribution_states
REFERENCING OLD TABLE AS changed_states FOR EACH STATEMENT EXECUTE FUNCTION refresh_changed_account_contributions();
CREATE TRIGGER account_contributions_deleted AFTER DELETE ON contribution_states
REFERENCING OLD TABLE AS changed_states FOR EACH STATEMENT EXECUTE FUNCTION refresh_changed_account_contributions();

-- Take the same writer lock before collector row locks, including when linking
-- historical devices or changing their eligibility for the public leaderboard.
CREATE FUNCTION lock_contribution_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(x'63776d77'::int::bigint);
    RETURN NULL;
END;
$$;
CREATE TRIGGER contribution_membership_lock BEFORE UPDATE OF account_id,active ON collectors
FOR EACH STATEMENT EXECUTE FUNCTION lock_contribution_membership();

CREATE FUNCTION refresh_contribution_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner bigint; affected bigint[];
BEGIN
    IF OLD.account_id IS NOT DISTINCT FROM NEW.account_id AND OLD.active=NEW.active THEN
        RETURN NULL;
    END IF;
    SELECT array_agg(DISTINCT shop_id) INTO affected FROM contribution_states WHERE collector_id=NEW.id;
    IF affected IS NULL THEN RETURN NULL; END IF;
    FOR owner IN SELECT DISTINCT a FROM unnest(ARRAY[OLD.account_id,NEW.account_id]) a
        WHERE a IS NOT NULL ORDER BY a
    LOOP
        -- Pairing a device with years of history is one grouped merge, rather
        -- than hundreds of thousands of individual shop queries.
        DELETE FROM contribution_account_shops WHERE account_id=owner AND shop_id=ANY(affected);
        INSERT INTO contribution_account_shops
        SELECT owner,scope.active_only,r.shop_id,
            count(DISTINCT (r.slot,r.item_id,r.variant_id,r.price,r.bundle,r.stock))
                FILTER (WHERE r.first_seen<=now()),
            now(),min(r.first_seen) FILTER (WHERE r.first_seen>now())
        FROM contribution_states r JOIN collectors c ON c.id=r.collector_id
        CROSS JOIN (VALUES(false),(true)) scope(active_only)
        WHERE c.account_id=owner AND r.shop_id=ANY(affected) AND (NOT scope.active_only OR c.active)
        GROUP BY scope.active_only,r.shop_id;
    END LOOP;
    RETURN NULL;
END;
$$;
CREATE TRIGGER contribution_membership_changed AFTER UPDATE OF account_id,active ON collectors
FOR EACH ROW EXECUTE FUNCTION refresh_contribution_membership();

-- One initial pass, with identical quote identity and future-time rules. Rolling
-- windows are intentionally excluded: their expiry cannot invalidate all-time
-- totals and force an unrelated reread of historical multiranges.
INSERT INTO contribution_account_shops
SELECT c.account_id,scope.active_only,r.shop_id,
    count(DISTINCT (r.slot,r.item_id,r.variant_id,r.price,r.bundle,r.stock))
        FILTER (WHERE r.first_seen<=now()),
    now(),min(r.first_seen) FILTER (WHERE r.first_seen>now())
FROM contribution_states r JOIN collectors c ON c.id=r.collector_id
CROSS JOIN (VALUES(false),(true)) scope(active_only)
WHERE c.account_id IS NOT NULL AND (NOT scope.active_only OR c.active)
GROUP BY c.account_id,scope.active_only,r.shop_id;
ANALYZE contribution_account_shops;

ALTER FUNCTION contribution_shop_counts(bigint[],integer,timestamptz)
RENAME TO contribution_device_shop_counts;

CREATE FUNCTION contribution_shop_counts(selected bigint[], period integer, at_time timestamptz)
RETURNS TABLE(shop_id bigint, quotes bigint) LANGUAGE plpgsql STABLE AS $$
DECLARE owner bigint; ids bigint[]; all_ids bigint[]; active_ids bigint[]; only_active boolean;
BEGIN
    -- Arbitrary device subsets and rolling windows keep the exact existing path.
    IF period=0 AND cardinality(selected)>0 THEN
        SELECT array_agg(DISTINCT i ORDER BY i) INTO ids FROM unnest(selected) i;
        SELECT c.account_id INTO owner FROM collectors c WHERE c.id=ids[1];
        IF owner IS NOT NULL THEN
            SELECT array_agg(c.id ORDER BY c.id),array_agg(c.id ORDER BY c.id) FILTER(WHERE c.active)
                INTO all_ids,active_ids FROM collectors c WHERE c.account_id=owner;
            IF ids=all_ids OR ids=active_ids THEN
                only_active := ids<>all_ids;
                IF NOT EXISTS (
                    SELECT 1 FROM contribution_account_shops a
                    WHERE a.account_id=owner AND a.active_only=only_active
                        AND (a.valid_from>at_time OR a.valid_until<=at_time)
                ) THEN
                    RETURN QUERY SELECT a.shop_id,a.quotes FROM contribution_account_shops a
                        WHERE a.account_id=owner AND a.active_only=only_active AND a.quotes>0;
                    RETURN;
                END IF;
                RETURN QUERY
                WITH candidates AS MATERIALIZED (
                    SELECT a.* FROM contribution_account_shops a
                    WHERE a.account_id=owner AND a.active_only=only_active
                )
                SELECT a.shop_id,a.quotes FROM candidates a
                WHERE a.valid_from<=at_time AND (a.valid_until IS NULL OR a.valid_until>at_time)
                    AND a.quotes>0
                UNION ALL
                SELECT a.shop_id,r.quotes FROM candidates a
                CROSS JOIN LATERAL (
                    SELECT count(DISTINCT (r.slot,r.item_id,r.variant_id,r.price,r.bundle,r.stock)) AS quotes
                    FROM collectors c CROSS JOIN LATERAL (
                        SELECT r.slot,r.item_id,r.variant_id,r.price,r.bundle,r.stock
                        FROM contribution_states r
                        WHERE r.collector_id=c.id AND r.shop_id=a.shop_id AND r.first_seen<=at_time OFFSET 0
                    ) r WHERE c.id=ANY(ids)
                ) r
                WHERE (a.valid_from>at_time OR a.valid_until<=at_time) AND r.quotes>0;
                RETURN;
            END IF;
        END IF;
    END IF;
    RETURN QUERY SELECT * FROM contribution_device_shop_counts(selected,period,at_time);
END;
$$;
