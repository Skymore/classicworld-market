-- Keep account IDs and the legacy Google column for rollback compatibility.
ALTER TABLE accounts ALTER COLUMN google_sub DROP NOT NULL;
CREATE TABLE account_identities (
    account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider = 'google'),
    subject text NOT NULL,
    PRIMARY KEY (provider, subject),
    UNIQUE (account_id, provider)
);
INSERT INTO account_identities(account_id,provider,subject)
SELECT id,'google',google_sub FROM accounts WHERE google_sub IS NOT NULL;
CREATE TABLE account_passwords (
    account_id bigint PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9_.-]{2,31}$'),
    password_hash text NOT NULL,
    recovery_hash bytea,
    changed_at timestamptz NOT NULL DEFAULT now()
);
-- Existing long-lived cookies are not evidence of a recent authentication.
ALTER TABLE account_sessions ADD COLUMN authenticated_at timestamptz NOT NULL DEFAULT 'epoch';
ALTER TABLE account_sessions ALTER COLUMN authenticated_at SET DEFAULT now();
ALTER TABLE google_login_states ADD COLUMN account_id bigint REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE google_login_states ADD COLUMN session_hash bytea;
ALTER TABLE google_login_states ADD CONSTRAINT google_link_session CHECK ((account_id IS NULL) = (session_hash IS NULL));
CREATE TABLE account_data (
    account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('watch','pref')),
    key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 64),
    value jsonb,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id,kind,key)
);
