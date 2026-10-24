ALTER TABLE site_pageviews ADD COLUMN country_code text NOT NULL DEFAULT ''
    CHECK (country_code = '' OR country_code ~ '^[A-Z]{2}$');
