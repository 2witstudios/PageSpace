/**
 * ClickHouse read shells for the analytics tier (#890 Phase 3 leaf 3).
 *
 * Thin I/O wrappers over the pure builders/parsers in
 * analytics-read-core.ts — each function executes one built query via the
 * provided client (JSONEachRow) and parses the rows to the PG-parity shape.
 * SERVER-SIDE ONLY: the client carries CH credentials; these functions must
 * never be reachable from a browser bundle (apps/web aliases
 * '@clickhouse/client' to false for browser builds; admin readers are only
 * imported from API routes).
 *
 * Unlike the insert adapters (never-throw, fire-and-forget), read errors
 * PROPAGATE — a monitoring dashboard that cannot read its store must say so,
 * not render empty panels.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import {
  type ChQuery,
  type TimeWindow,
  buildActiveUserCountQuery,
  buildActivityHeatmapQuery,
  buildEndpointPerformanceQuery,
  buildErrorPatternsQuery,
  buildErrorTrendsQuery,
  buildFailedLoginsQuery,
  buildFeatureUsageQuery,
  buildLogsByLevelQuery,
  buildMostActiveUsersQuery,
  buildRecentErrorsQuery,
  buildRequestErrorCountsQuery,
  buildResponseTimesQuery,
  buildSlowQueriesQuery,
  buildTopEndpointsQuery,
  buildVolumeOverTimeQuery,
  parseActiveUserCount,
  parseActivityHeatmapRows,
  parseEndpointPerformanceRows,
  parseErrorPatternRows,
  parseErrorTrendRows,
  parseFailedLoginRows,
  parseFeatureUsageRows,
  parseLogsByLevelRows,
  parseMostActiveUserRows,
  parseRecentErrorRows,
  parseRequestErrorCounts,
  parseResponseTimeRows,
  parseSlowQueryRows,
  parseTopEndpointRows,
  parseVolumeOverTimeRows,
  type ActivityHeatmapRow,
  type EndpointPerformanceRow,
  type ErrorPatternRow,
  type ErrorTrendRow,
  type FailedLoginRow,
  type FeatureUsageRow,
  type LogsByLevelRow,
  type MostActiveUserRow,
  type RecentErrorRow,
  type RequestErrorCounts,
  type ResponseTimeRow,
  type SlowQueryRow,
  type TopEndpointRow,
  type VolumeOverTimeRow,
} from './analytics-read-core';

export type { TimeWindow } from './analytics-read-core';

async function selectRows(client: ClickHouseClient, built: ChQuery): Promise<unknown[]> {
  const resultSet = await client.query({
    query: built.query,
    query_params: built.query_params,
    format: 'JSONEachRow',
  });
  return resultSet.json<unknown>();
}

// ── system_logs ──────────────────────────────────────────────────────────────

export const getLogsByLevel = async (
  client: ClickHouseClient,
  window: TimeWindow,
): Promise<LogsByLevelRow[]> => parseLogsByLevelRows(await selectRows(client, buildLogsByLevelQuery(window)));

export const getErrorTrends = async (
  client: ClickHouseClient,
  window: TimeWindow,
): Promise<ErrorTrendRow[]> => parseErrorTrendRows(await selectRows(client, buildErrorTrendsQuery(window)));

export const getFailedLogins = async (
  client: ClickHouseClient,
  window: TimeWindow,
): Promise<FailedLoginRow[]> => parseFailedLoginRows(await selectRows(client, buildFailedLoginsQuery(window)));

// ── error_logs ───────────────────────────────────────────────────────────────

export const getRecentErrors = async (
  client: ClickHouseClient,
  window: TimeWindow,
  limit: number,
): Promise<RecentErrorRow[]> =>
  parseRecentErrorRows(await selectRows(client, buildRecentErrorsQuery(window, limit)));

export const getErrorPatterns = async (
  client: ClickHouseClient,
  window: TimeWindow,
): Promise<ErrorPatternRow[]> =>
  parseErrorPatternRows(await selectRows(client, buildErrorPatternsQuery(window)));

// ── api_metrics ──────────────────────────────────────────────────────────────

export const getVolumeOverTime = async (
  client: ClickHouseClient,
  window: TimeWindow,
): Promise<VolumeOverTimeRow[]> =>
  parseVolumeOverTimeRows(await selectRows(client, buildVolumeOverTimeQuery(window)));

export const getTopEndpoints = async (
  client: ClickHouseClient,
  window: TimeWindow,
): Promise<TopEndpointRow[]> =>
  parseTopEndpointRows(await selectRows(client, buildTopEndpointsQuery(window)));

export const getRequestErrorCounts = async (
  client: ClickHouseClient,
  window: TimeWindow,
): Promise<RequestErrorCounts> =>
  parseRequestErrorCounts(await selectRows(client, buildRequestErrorCountsQuery(window)));

export const getResponseTimes = async (
  client: ClickHouseClient,
  window: TimeWindow,
): Promise<ResponseTimeRow[]> =>
  parseResponseTimeRows(await selectRows(client, buildResponseTimesQuery(window)));

export const getSlowQueries = async (
  client: ClickHouseClient,
  window: TimeWindow,
): Promise<SlowQueryRow[]> =>
  parseSlowQueryRows(await selectRows(client, buildSlowQueriesQuery(window)));

export const getEndpointPerformance = async (
  client: ClickHouseClient,
  window: TimeWindow,
): Promise<EndpointPerformanceRow[]> =>
  parseEndpointPerformanceRows(await selectRows(client, buildEndpointPerformanceQuery(window)));

// ── user_activities ──────────────────────────────────────────────────────────

export const getActivityHeatmap = async (
  client: ClickHouseClient,
  window: TimeWindow,
): Promise<ActivityHeatmapRow[]> =>
  parseActivityHeatmapRows(await selectRows(client, buildActivityHeatmapQuery(window)));

export const getMostActiveUsers = async (
  client: ClickHouseClient,
  window: TimeWindow,
  limit: number,
): Promise<MostActiveUserRow[]> =>
  parseMostActiveUserRows(await selectRows(client, buildMostActiveUsersQuery(window, limit)));

export const getFeatureUsage = async (
  client: ClickHouseClient,
  window: TimeWindow,
): Promise<FeatureUsageRow[]> =>
  parseFeatureUsageRows(await selectRows(client, buildFeatureUsageQuery(window)));

export const getActiveUserCount = async (
  client: ClickHouseClient,
  since: Date,
): Promise<number> => parseActiveUserCount(await selectRows(client, buildActiveUserCountQuery(since)));
