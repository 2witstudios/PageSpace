/**
 * prometheus-client — reads Fly's MANAGED PROMETHEUS, the only independent record
 * of whether a machine was actually up.
 *
 * Fly has no billing API. Our own start/stop calls are the primary awake-seconds
 * record and the local event mirror is what keeps them (Fly's own event log holds
 * only the last 20 entries). Managed Prometheus is the third leg: an
 * independently-produced series, retained about 15 days, that can be compared
 * against what we billed. It is a CHECK, never a source — 15 days of retention
 * cannot rebuild a billing history, and a scraped gauge is not evidence of a
 * charge.
 *
 * CREDENTIAL. The org token that drives the Machines API is reused as the Bearer
 * here, and the org slug comes from `FLY_PROMETHEUS_ORG_SLUG`. If the two ever
 * need to diverge — a read-only metrics token, a different org for staging —
 * `resolveFlyPrometheus` is the single seam that changes; nothing else in the
 * reconcile knows where either value came from.
 *
 * INERT WHEN UNCONFIGURED. Missing slug or missing token resolves to `null` and
 * the reconcile skips cleanly with a counter, never an error. The feature ships
 * dark, and a dark feature must not redden a live cron.
 */

import { resolveFlyMachinesToken } from '../app-hosting/app-hosting-env';

export const FLY_PROMETHEUS_BASE_URL = 'https://api.fly.io/prometheus';

/** Request budget for one instant query. Generous: a `count_over_time` across a week is not a fast query. */
export const FLY_PROMETHEUS_TIMEOUT_MS = 30_000;

/**
 * How often Fly scrapes `fly_instance_up`, in seconds.
 *
 * Load-bearing: `count_over_time` returns a SAMPLE COUNT, and seconds-awake is
 * that count times this interval. `avg_over_time` would avoid needing it, but only
 * if the series reported 0 while a machine is down — a stopped machine has nothing
 * to scrape, so its series goes ABSENT rather than zero, and an average over the
 * samples that exist reads as "up 100% of the time" for every app.
 *
 * NOT VERIFIED against a live org — it is on the epic's "verify before depending"
 * list. A wrong value scales the reconcile's remote figure linearly, which shows
 * up as a constant proportional drift on every app rather than as a silent error,
 * and is corrected by this one env var.
 */
export const FLY_METRICS_SCRAPE_INTERVAL_SECONDS = (() => {
  const raw = process.env.FLY_METRICS_SCRAPE_INTERVAL_SECONDS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return 15;
  const parsed = Number.parseInt(raw, 10);
  return parsed > 0 ? parsed : 15;
})();

export interface FlyPrometheusConfig {
  orgSlug: string;
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * The configured endpoint, or null when either half is missing.
 *
 * Reads `process.env` directly rather than through `getValidatedEnv()`, matching
 * `resolveFlyMachinesToken` next door and for the same reason: this is read from
 * services whose lean env makes the validated accessor THROW, which would blank a
 * correctly-configured credential.
 */
export function resolveFlyPrometheus(): FlyPrometheusConfig | null {
  const orgSlug = process.env.FLY_PROMETHEUS_ORG_SLUG?.trim();
  const token = resolveFlyMachinesToken();
  if (!orgSlug || !token) return null;
  return { orgSlug, token };
}

export class FlyPrometheusError extends Error {
  constructor(message: string, public readonly status: number | null) {
    super(message);
    this.name = 'FlyPrometheusError';
  }
}

interface InstantQueryBody {
  status?: string;
  data?: { resultType?: string; result?: Array<{ value?: [number, string] }> };
  error?: string;
}

/**
 * Run one instant PromQL query and return the FIRST series' scalar value, or null
 * when the query matched nothing.
 *
 * "Matched nothing" is an ordinary answer here, not an error: an app that has never
 * been woken has no `fly_instance_up` series at all, and reading that as a failure
 * would make every unwoken app look like a metrics outage.
 */
export async function queryInstant(
  config: FlyPrometheusConfig,
  query: string,
): Promise<number | null> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const base = config.baseUrl ?? FLY_PROMETHEUS_BASE_URL;
  const url = `${base}/${encodeURIComponent(config.orgSlug)}/api/v1/query?query=${encodeURIComponent(query)}`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(FLY_PROMETHEUS_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new FlyPrometheusError(
      `Fly Prometheus query failed with ${response.status}`,
      response.status,
    );
  }
  const body = (await response.json()) as InstantQueryBody;
  if (body.status !== 'success') {
    throw new FlyPrometheusError(body.error ?? 'Fly Prometheus returned a non-success status', null);
  }
  const raw = body.data?.result?.[0]?.value?.[1];
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The PromQL for "how many samples saw this app's instance up over `windowSeconds`".
 *
 * `count_over_time` rather than `sum_over_time` deliberately: the gauge's VALUE is
 * 1 while up, so the two agree today, but a future value other than 1 would make
 * `sum_over_time` silently scale the answer. Counting samples asks the question
 * the reconcile actually means — how much of the window had a live instance to
 * scrape.
 */
export function awakeSamplesQuery(flyAppName: string, windowSeconds: number): string {
  // The app label is a Fly app name (`pgs-app-<cuid2>`), so it cannot contain a
  // quote or backslash — but escaping it anyway keeps this function safe to call
  // with any string rather than only with names we happen to generate.
  const escaped = flyAppName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `count_over_time(fly_instance_up{app="${escaped}"}[${Math.max(1, Math.floor(windowSeconds))}s])`;
}

/**
 * Seconds this app's instance was up over the window, per managed Prometheus.
 * Null when the app has no series at all (never woken, or destroyed long enough
 * ago that its samples have aged out).
 */
export async function queryAwakeSeconds(
  config: FlyPrometheusConfig,
  flyAppName: string,
  windowSeconds: number,
): Promise<number | null> {
  const samples = await queryInstant(config, awakeSamplesQuery(flyAppName, windowSeconds));
  if (samples === null) return null;
  return Math.max(0, samples * FLY_METRICS_SCRAPE_INTERVAL_SECONDS);
}
