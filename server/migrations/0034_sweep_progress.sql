-- Latest per-device scanner counter. Old clients may omit it; unknown stays NULL.
ALTER TABLE sweep_run_devices ADD COLUMN checked bigint CHECK (checked BETWEEN 0 AND 1000000000000);
ALTER TABLE sweep_run_devices ADD COLUMN progress_at timestamptz;
