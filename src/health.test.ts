import { describe, expect, it } from "vitest";
import type { CollectionStats } from "./storage/d1";
import { assembleHealth, coveragePct, pct, scheduledPolls } from "./health";

const emptyStats: CollectionStats = {
  invocations: 0,
  successfulPolls: 0,
  fleetPolls: 0,
  graphqlPolls: 0,
  failedPolls: 0,
  offlinePolls: 0,
  outOfRegionPolls: 0,
  avgLatencyMs: null,
  avgStationsPerPoll: null,
  avgStationsWhenSampled: null,
  firstScheduledAt: null,
  last: null,
  statusCounts: {},
  httpErrors: [],
  samples: 0,
  staleSamples: 0,
};

describe("coverage formula", () => {
  it("is successful collection intervals / scheduled collection intervals", () => {
    expect(scheduledPolls(24, 5)).toBe(288);
    expect(coveragePct(274, 288)).toBe(95.1);
    expect(coveragePct(0, 288)).toBe(0);
    expect(coveragePct(10, 0)).toBe(0);
  });

  it("reports plan metrics from poll and sample aggregates", () => {
    const payload = assembleHealth({
      windowHours: 24,
      intervalMinutes: 5,
      now: new Date("2026-08-25T00:00:00.000Z"),
      sinceIso: "2026-08-24T00:00:00.000Z",
      stats: {
        ...emptyStats,
        invocations: 288,
        successfulPolls: 40,
        fleetPolls: 40,
        graphqlPolls: 0,
        failedPolls: 2,
        offlinePolls: 246,
        avgLatencyMs: 1234.4,
        avgStationsPerPoll: 2.5,
        avgStationsWhenSampled: 18,
        firstScheduledAt: "2026-08-24T00:00:00.000Z",
        statusCounts: { success: 40, fleet_vehicle_offline: 246, fleet_error: 2 },
        httpErrors: [{ source: "fleet", httpStatus: 408, count: 1 }],
        samples: 720,
        staleSamples: 12,
      },
      mode: "fleet_only",
      graphqlOn: false,
      bbox: { north: 30.5, south: 30, west: -98.25, east: -97.7 },
      markers: { lastSuccess: null, lastFleetSuccess: null, lastGraphqlSuccess: null },
    });

    const coverage = payload.coverage as Record<string, number>;
    const polls = payload.polls as Record<string, unknown>;
    const samples = payload.samples as Record<string, number>;
    const errors = payload.api_errors_by_source as { fleet: { http_status: number }[] };

    expect(coverage.scheduled_polls).toBe(288);
    expect(coverage.successful_polls).toBe(40);
    expect(coverage.coverage_pct).toBe(13.9);
    expect(polls.fleet).toBe(40);
    expect(polls.graphql).toBe(0);
    expect(polls.failed).toBe(2);
    expect(polls.avg_latency_ms).toBe(1234.4);
    expect(polls.avg_stations_when_sampled).toBe(18);
    expect(samples.stale_congestion).toBe(12);
    expect(samples.stale_pct).toBe(pct(12, 720));
    expect(errors.fleet[0]?.http_status).toBe(408);
  });
});
