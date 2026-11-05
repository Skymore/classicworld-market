-- The shop view lists every stall of a room: read by world, channel and room,
-- newest stall reading first. Only shops with a stall reading are indexed.
CREATE INDEX shops_stall_room_idx ON shops (world, channel, room, stall_seen_at DESC)
    WHERE stall_seen_at IS NOT NULL;
