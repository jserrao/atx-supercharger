CREATE TABLE stations (
    id TEXT PRIMARY KEY,
    fleet_id TEXT,
    graphql_id TEXT,
    name TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    total_stalls INTEGER,
    max_power_kw INTEGER,
    amenities TEXT,
    match_method TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_stations_fleet_id
ON stations(fleet_id)
WHERE fleet_id IS NOT NULL;

CREATE UNIQUE INDEX idx_stations_graphql_id
ON stations(graphql_id)
WHERE graphql_id IS NOT NULL;

CREATE TABLE poll_runs (
    id TEXT PRIMARY KEY,
    scheduled_at TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    vehicle_state TEXT,
    source_used TEXT,
    fleet_status INTEGER,
    graphql_status INTEGER,
    sample_count INTEGER DEFAULT 0,
    latency_ms INTEGER,
    status TEXT NOT NULL,
    error TEXT
);

CREATE UNIQUE INDEX idx_poll_runs_scheduled_at ON poll_runs(scheduled_at);
CREATE INDEX idx_poll_runs_started_at ON poll_runs(started_at);
CREATE INDEX idx_poll_runs_status ON poll_runs(status);

CREATE TABLE station_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_run_id TEXT NOT NULL,
    station_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    source TEXT NOT NULL,
    available_stalls INTEGER,
    total_stalls INTEGER,
    occupied_stalls INTEGER,
    utilization_pct REAL,
    site_closed INTEGER,
    congestion_sync_at TEXT,
    congestion_age_seconds INTEGER,
    is_stale INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (poll_run_id) REFERENCES poll_runs(id),
    FOREIGN KEY (station_id) REFERENCES stations(id)
);

CREATE UNIQUE INDEX idx_samples_poll_station
ON station_samples(poll_run_id, station_id);

CREATE INDEX idx_samples_station_time
ON station_samples(station_id, observed_at);

CREATE INDEX idx_samples_time
ON station_samples(observed_at);

CREATE INDEX idx_samples_source
ON station_samples(source);

CREATE TABLE raw_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_run_id TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    FOREIGN KEY (poll_run_id) REFERENCES poll_runs(id)
);

CREATE INDEX idx_raw_created_at ON raw_responses(created_at);
CREATE INDEX idx_raw_poll_run ON raw_responses(poll_run_id);

CREATE TABLE source_comparisons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_run_id TEXT NOT NULL,
    station_id TEXT,
    fleet_available INTEGER,
    graphql_available INTEGER,
    available_delta INTEGER,
    congestion_age_delta_seconds INTEGER,
    identity_match INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (poll_run_id) REFERENCES poll_runs(id)
);

CREATE INDEX idx_comparisons_poll_run ON source_comparisons(poll_run_id);
