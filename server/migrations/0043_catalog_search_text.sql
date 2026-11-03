-- Catalogue and watchlist search matched every keyword against names
-- normalized per row on each request (`search::normalized_sql`): about
-- 12.5 us a row, 97 ms of database time for one `/search?q=`. Store the
-- normalized text instead. `catalog_search_text` is the same expression,
-- so every search returns exactly what it did; Postgres keeps the column
-- current on every insert and update.
--
-- concat_ws skips NULL names as before. Declared IMMUTABLE for the
-- generated column: for text arguments it depends on nothing else.
CREATE FUNCTION catalog_search_text(VARIADIC parts text[]) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(regexp_replace(translate(concat_ws(chr(31), VARIADIC parts),
    '！＂＃＄％＆＇（）＊＋，－．／０１２３４５６７８９：；＜＝＞？＠ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ［＼］＾＿｀ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ｛｜｝～',
    '!"#$%&''()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrstuvwxyz{|}~'),
    '[[:space:]　]+', '', 'g'))
$$;

ALTER TABLE items ADD COLUMN search_text text
  GENERATED ALWAYS AS (catalog_search_text(name_zh, name_en, id::text)) STORED;
ALTER TABLE mobs ADD COLUMN search_text text
  GENERATED ALWAYS AS (catalog_search_text(name_zh, name_tw, name_en, id::text)) STORED;
ALTER TABLE maps ADD COLUMN search_text text
  GENERATED ALWAYS AS (catalog_search_text(name_zh, name_tw, name_en, id::text)) STORED;
