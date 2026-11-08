-- A newer stall of another owner at the same spot (stalls standing together are
-- always at least 120px apart) proves the older shop closed: retire it like a
-- departure.
ALTER TABLE player_departures DROP CONSTRAINT player_departures_evidence_kind_check;
ALTER TABLE player_departures ADD CONSTRAINT player_departures_evidence_kind_check
    CHECK (evidence_kind IN ('player_departure','room_roster','stall_replaced'));
