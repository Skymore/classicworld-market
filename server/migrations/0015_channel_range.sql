-- Match the channel ID representation accepted by packet and screen readers.
ALTER TABLE observations DROP CONSTRAINT IF EXISTS observations_map_channel_check;
ALTER TABLE observations ADD CONSTRAINT observations_map_channel_check
    CHECK (map_channel BETWEEN 1 AND 255);
