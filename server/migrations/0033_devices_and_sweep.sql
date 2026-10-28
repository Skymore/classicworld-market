-- Signed-in collectors are account devices. Tokens and codes are stored as sha256 only.
CREATE TABLE account_devices (
    id bigserial PRIMARY KEY,
    public_id text NOT NULL UNIQUE,
    account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    collector_id bigint REFERENCES collectors(id),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    token_hash bytea NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    client_version text NOT NULL DEFAULT '' CHECK (char_length(client_version) <= 32),
    state jsonb,
    revoked_at timestamptz
);
CREATE INDEX account_devices_account_idx ON account_devices(account_id) WHERE revoked_at IS NULL;
CREATE INDEX account_devices_collector_idx ON account_devices(collector_id);
-- Set once a collector exchanges any device token, linked or not; migrate is then refused.
ALTER TABLE collectors ADD COLUMN device_token_issued_at timestamptz;
CREATE TABLE device_authorizations (
    code_hash bytea PRIMARY KEY,
    account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    challenge text NOT NULL,
    redirect_uri text NOT NULL,
    name text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz
);
CREATE INDEX device_authorizations_expiry_idx ON device_authorizations(expires_at);
-- started_by NULL means the website started the run.
CREATE TABLE sweep_runs (
    id bigserial PRIMARY KEY,
    public_id text NOT NULL UNIQUE,
    account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    plan jsonb NOT NULL,
    plan_version integer NOT NULL DEFAULT 1 CHECK (plan_version > 0),
    budget bigint NOT NULL CHECK (budget BETWEEN 1 AND 1000000000000),
    status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','stopped','finished')),
    stop_reason text,
    started_by bigint REFERENCES account_devices(id),
    started_at timestamptz NOT NULL DEFAULT now(),
    ends_at timestamptz NOT NULL,
    stopped_at timestamptz,
    CHECK ((status = 'running') = (stopped_at IS NULL))
);
CREATE UNIQUE INDEX sweep_one_running_run ON sweep_runs(account_id) WHERE status = 'running';
CREATE INDEX sweep_runs_recent_idx ON sweep_runs(account_id, stopped_at);
CREATE TABLE sweep_run_devices (
    run_id bigint NOT NULL REFERENCES sweep_runs(id) ON DELETE CASCADE,
    device_id bigint NOT NULL REFERENCES account_devices(id),
    state text NOT NULL DEFAULT 'invited' CHECK (state IN ('invited','active','refused','left')),
    lease_hash bytea,
    lease_expires_at timestamptz,
    plan_version integer,
    message text NOT NULL DEFAULT '',
    PRIMARY KEY (run_id, device_id)
);
CREATE INDEX sweep_run_devices_device_idx ON sweep_run_devices(device_id);
-- quantity is the granted purchase count; cost and units count fully until settled.
CREATE TABLE sweep_reservations (
    id bigserial PRIMARY KEY,
    public_id text NOT NULL UNIQUE,
    run_id bigint NOT NULL REFERENCES sweep_runs(id) ON DELETE CASCADE,
    device_id bigint NOT NULL REFERENCES account_devices(id),
    listing text NOT NULL,
    item_id integer NOT NULL,
    quantity bigint NOT NULL CHECK (quantity > 0),
    units_per bigint NOT NULL CHECK (units_per > 0),
    bundle bigint NOT NULL CHECK (bundle > 0),
    price bigint NOT NULL CHECK (price > 0),
    cost bigint NOT NULL CHECK (cost > 0),
    status text NOT NULL DEFAULT 'held'
        CHECK (status IN ('held','bought','not_bought','unknown','expired')),
    bought_quantity bigint NOT NULL DEFAULT 0,
    spent bigint NOT NULL DEFAULT 0,
    reason text NOT NULL DEFAULT '',
    location jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    settled_at timestamptz,
    UNIQUE (run_id, listing)
);
CREATE INDEX sweep_reservations_run_idx ON sweep_reservations(run_id, created_at DESC);
CREATE INDEX sweep_reservations_device_idx ON sweep_reservations(device_id);
