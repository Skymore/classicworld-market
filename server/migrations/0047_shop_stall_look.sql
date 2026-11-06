-- How a stall's owner looks (gender, skin, face, hair, visible equips by slot,
-- cash weapon), read from the same map-entry record as the stall; the shop
-- map draws the owner from it. NULL until a collector that reads it visits.
ALTER TABLE shops ADD COLUMN stall_look jsonb;
