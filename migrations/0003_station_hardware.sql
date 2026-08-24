ALTER TABLE stations ADD COLUMN hardware_generation TEXT;
ALTER TABLE station_samples ADD COLUMN max_power_kw INTEGER;
ALTER TABLE station_samples ADD COLUMN hardware_generation TEXT;
ALTER TABLE station_samples ADD COLUMN amenities TEXT;
ALTER TABLE station_samples ADD COLUMN billing_info TEXT;

CREATE INDEX idx_samples_hardware_generation ON station_samples(hardware_generation);
CREATE INDEX idx_stations_hardware_generation ON stations(hardware_generation);
