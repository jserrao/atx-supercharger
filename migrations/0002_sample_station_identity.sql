ALTER TABLE station_samples ADD COLUMN station_name TEXT;
ALTER TABLE station_samples ADD COLUMN source_station_id TEXT;

CREATE INDEX idx_samples_station_name ON station_samples(station_name);
CREATE INDEX idx_samples_source_station_id ON station_samples(source_station_id);
CREATE INDEX idx_stations_name ON stations(name);
