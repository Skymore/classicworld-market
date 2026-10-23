-- Preserve map-entry context for shops visited outside Free Market rooms.
ALTER TABLE observations ADD COLUMN map_channel smallint CHECK (map_channel BETWEEN 1 AND 18);
ALTER TABLE observations ADD COLUMN map_id integer CHECK (map_id >= 0 AND map_id < 1000000000);
