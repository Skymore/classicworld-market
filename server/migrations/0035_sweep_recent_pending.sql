-- Shops a device still has to revisit while buying recent matches: 0 = queue empty, waiting.
-- NULL when the device is not in recent-match mode or has not reported it.
ALTER TABLE sweep_run_devices ADD COLUMN recent_pending integer CHECK (recent_pending BETWEEN 0 AND 100000);
