-- Run before restarting a pre-0044 binary. Removes only the new read model;
-- original device contributions and observations are preserved.
BEGIN;
SELECT pg_advisory_xact_lock(x'63776d77'::int::bigint);
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM _sqlx_migrations WHERE version>44) THEN
        RAISE EXCEPTION 'Review newer migrations before rolling back account contribution rollups';
    END IF;
END $$;
DROP TRIGGER account_contributions_inserted ON contribution_states;
DROP TRIGGER account_contributions_updated ON contribution_states;
DROP TRIGGER account_contributions_moved ON contribution_states;
DROP TRIGGER account_contributions_deleted ON contribution_states;
DROP TRIGGER contribution_membership_lock ON collectors;
DROP TRIGGER contribution_membership_changed ON collectors;
DROP FUNCTION contribution_shop_counts(bigint[],integer,timestamptz);
ALTER FUNCTION contribution_device_shop_counts(bigint[],integer,timestamptz) RENAME TO contribution_shop_counts;
DROP FUNCTION refresh_changed_account_contributions();
DROP FUNCTION refresh_contribution_membership();
DROP FUNCTION lock_contribution_membership();
DROP FUNCTION refresh_account_contribution_shop(bigint,bigint);
DROP TABLE contribution_account_shops;
DELETE FROM _sqlx_migrations WHERE version=44;
COMMIT;
