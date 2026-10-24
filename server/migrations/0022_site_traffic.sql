-- Anonymous browser page views. No IP, account, query string or raw referrer.
CREATE TABLE site_pageviews (
    event_id text PRIMARY KEY CHECK (event_id ~ '^[0-9a-f]{32}$'),
    received_at timestamptz NOT NULL DEFAULT now(),
    day date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
    visitor_hash bytea NOT NULL CHECK (octet_length(visitor_hash) = 32),
    path text NOT NULL CHECK (length(path) BETWEEN 1 AND 160),
    source text NOT NULL CHECK (length(source) <= 253),
    device text NOT NULL CHECK (device IN ('phone', 'tablet', 'desktop'))
);
CREATE INDEX site_pageviews_day_visitor ON site_pageviews(day, visitor_hash);
