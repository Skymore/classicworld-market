-- Where a shop stands in its Free Market room (world pixels) and the store
-- permit that sets its look. Packet collectors read both from the owner's
-- map-entry record; the newest observation that carries a stall wins.
ALTER TABLE shops
    ADD COLUMN stall_x smallint,
    ADD COLUMN stall_y smallint,
    ADD COLUMN stall_permit integer,
    ADD COLUMN stall_seen_at timestamptz;
