ALTER TABLE stations ADD COLUMN google_place_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_stations_google_place_id
ON stations(google_place_id)
WHERE google_place_id IS NOT NULL;

ALTER TABLE poll_runs ADD COLUMN google_status INTEGER;
ALTER TABLE poll_runs ADD COLUMN google_requests INTEGER DEFAULT 0;

ALTER TABLE source_comparisons ADD COLUMN google_available INTEGER;
