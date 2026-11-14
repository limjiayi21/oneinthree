-- Teaching replay: five moments instead of three.
-- guided_m1..m5 hold the first choice id picked at each moment (ids only, never words).
-- Rows written before this migration hold ids from the earlier three-moment replay in
-- guided_m1..m3; GET /api/stats ignores any id that is not in the current content/guided.json.
ALTER TABLE playthroughs ADD COLUMN guided_m4 TEXT;
ALTER TABLE playthroughs ADD COLUMN guided_m5 TEXT;
