-- Removes the old raw page capture table (full HTML of every page).
-- Replaced by the activity → memory pipeline in schema.sql.
-- This permanently deletes everything captured so far. Run manually.

DROP TABLE IF EXISTS page_visits;
