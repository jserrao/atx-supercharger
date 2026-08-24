export type ObservationSource = "fleet" | "graphql";

export type CollectorMode = "fleet_only" | "auto" | "dual";

export type PollStatus =
  | "success"
  | "partial_success"
  | "fleet_vehicle_offline"
  | "fleet_out_of_region"
  | "fleet_error"
  | "graphql_error"
  | "graphql_auth_failure"
  | "graphql_disabled"
  | "rate_limited"
  | "no_data"
  | "not_connected"
  | "lock_skipped";

export type ChargerObservation = {
  source: ObservationSource;
  sourceStationId: string;
  name: string;
  latitude: number;
  longitude: number;
  availableStalls: number | null;
  totalStalls: number | null;
  occupiedStalls: number | null;
  utilizationPct: number | null;
  siteClosed: boolean | null;
  maxPowerKw: number | null;
  congestionSyncAt: string | null;
  congestionAgeSeconds: number | null;
  observedAt: string;
  amenities: unknown;
  raw: unknown;
};

export type BoundingBox = {
  north: number;
  south: number;
  west: number;
  east: number;
};

export type AppConfig = {
  collectionIntervalMinutes: number;
  bbox: BoundingBox;
  fleetCount: number;
  fleetRadius: number;
  staleThresholdSeconds: number;
  matchDistanceMeters: number;
  rawRetentionDays: number;
  collectorMode: CollectorMode;
  teslaAudience: string;
  teslaRedirectUri: string;
  teslaVin: string;
  teslaClientId: string;
  teslaClientSecret: string;
  teslaPublicKey: string;
  adminToken: string;
};

export type TeslaHttpResult = {
  ok: boolean;
  status: number;
  method: string;
  path: string;
  data: unknown;
};

export type ProviderResult = {
  ok: boolean;
  status: number;
  source: ObservationSource;
  observations: ChargerObservation[];
  raw: unknown;
  error: string | null;
};

export type VehicleSnapshot = {
  vin: string | null;
  displayName: string | null;
  state: string | null;
};

export type StationRecord = {
  id: string;
  fleet_id: string | null;
  graphql_id: string | null;
  name: string;
  latitude: number;
  longitude: number;
  total_stalls: number | null;
  max_power_kw: number | null;
  amenities: string | null;
  match_method: string | null;
  first_seen_at: string;
  last_seen_at: string;
};

export type SourceComparison = {
  stationId: string | null;
  fleetAvailable: number | null;
  graphqlAvailable: number | null;
  availableDelta: number | null;
  congestionAgeDeltaSeconds: number | null;
  identityMatch: boolean;
};
