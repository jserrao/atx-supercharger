ALTER TABLE station_samples ADD COLUMN scheduled_at TEXT;
ALTER TABLE station_samples ADD COLUMN polled_at TEXT;

UPDATE station_samples
SET scheduled_at = (
    SELECT poll_runs.scheduled_at
    FROM poll_runs
    WHERE poll_runs.id = station_samples.poll_run_id
)
WHERE scheduled_at IS NULL;

UPDATE station_samples
SET polled_at = observed_at
WHERE polled_at IS NULL;

CREATE INDEX idx_samples_scheduled_at ON station_samples(scheduled_at);
CREATE INDEX idx_samples_station_scheduled ON station_samples(station_id, scheduled_at);
