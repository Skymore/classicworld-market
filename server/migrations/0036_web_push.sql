-- Browser push subscriptions. Each belongs to the signed-in session that created it,
-- so logout, session expiry and "sign out everywhere" remove it with the session.
CREATE TABLE push_subscriptions (
    id bigserial PRIMARY KEY,
    public_id text NOT NULL UNIQUE,
    account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    session_hash bytea NOT NULL REFERENCES account_sessions(token_hash) ON DELETE CASCADE,
    endpoint text NOT NULL UNIQUE CHECK (char_length(endpoint) <= 1024),
    p256dh bytea NOT NULL CHECK (octet_length(p256dh) = 65),
    auth bytea NOT NULL CHECK (octet_length(auth) = 16),
    label text NOT NULL DEFAULT '' CHECK (char_length(label) <= 40),
    lang text NOT NULL DEFAULT 'zh' CHECK (lang IN ('zh', 'en')),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_sent_at timestamptz
);
CREATE INDEX push_subscriptions_account_idx ON push_subscriptions(account_id, created_at);
CREATE INDEX push_subscriptions_session_idx ON push_subscriptions(session_hash);
-- Offers observed after started_at and after the previous round are new for the account.
-- Removed when the account has no subscriptions, so a new subscription starts quietly.
CREATE TABLE push_cursors (
    account_id bigint PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    started_at timestamptz NOT NULL,
    cursor_at timestamptz NOT NULL
);
-- Offer identities (shop, item, unit price, bundle, equipment) pushed in the last 24 hours.
CREATE TABLE push_deliveries (
    account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    offer_key bytea NOT NULL CHECK (octet_length(offer_key) = 32),
    sent_at timestamptz NOT NULL,
    PRIMARY KEY (account_id, offer_key)
);
CREATE INDEX push_deliveries_sent_idx ON push_deliveries(sent_at);
