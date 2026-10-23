-- Opt-in public contributor profiles. Existing collector tokens remain valid.
CREATE TABLE accounts (
    id bigserial PRIMARY KEY,
    public_id text NOT NULL UNIQUE,
    google_sub text NOT NULL UNIQUE,
    nickname text NOT NULL DEFAULT '',
    listed boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (char_length(nickname) <= 24)
);
ALTER TABLE collectors ADD COLUMN account_id bigint REFERENCES accounts(id);
ALTER TABLE collectors ADD COLUMN nickname text NOT NULL DEFAULT '';
ALTER TABLE collectors ADD COLUMN listed boolean NOT NULL DEFAULT false;
CREATE INDEX collectors_account_idx ON collectors(account_id);
CREATE TABLE account_sessions (
    token_hash bytea PRIMARY KEY,
    account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    csrf text NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE INDEX account_sessions_expiry_idx ON account_sessions(expires_at);
CREATE TABLE google_login_states (
    state_hash bytea PRIMARY KEY,
    browser_hash bytea NOT NULL,
    nonce text NOT NULL,
    verifier text NOT NULL,
    link_code text,
    expires_at timestamptz NOT NULL
);
CREATE TABLE collector_account_links (
    code_hash bytea PRIMARY KEY,
    collector_id bigint NOT NULL REFERENCES collectors(id),
    expires_at timestamptz NOT NULL,
    used_at timestamptz
);
CREATE INDEX google_login_states_expiry_idx ON google_login_states(expires_at);
CREATE INDEX collector_account_links_expiry_idx ON collector_account_links(expires_at);
CREATE INDEX observations_collector_time_idx ON observations(collector_id, observed_at);
