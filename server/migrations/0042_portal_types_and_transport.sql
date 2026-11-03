-- WZ portal type from NiaDB: 1 hidden (no picture; stand on it and press up),
-- 2 visible, 3 entered by walking into it. NULL for return links, ships and taxis.
ALTER TABLE map_portals ADD COLUMN portal_type smallint;

-- `import_catalog` now writes the Southperry ship and the town taxis
-- (`route::TRANSPORT`) as `ship` / `taxi` edges with source 'niadb'.
