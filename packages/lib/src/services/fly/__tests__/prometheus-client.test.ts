import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { assert } from '../../sandbox/__tests__/riteway';
import {
  awakeSamplesQuery,
  queryInstant,
  queryAwakeSeconds,
  resolveFlyPrometheus,
  FlyPrometheusError,
  FLY_METRICS_SCRAPE_INTERVAL_SECONDS,
  FLY_PROMETHEUS_BASE_URL,
  type FlyPrometheusConfig,
} from '../prometheus-client';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function config(fetchImpl: typeof fetch): FlyPrometheusConfig {
  return { orgSlug: 'my-org', token: 'tok-1', fetchImpl };
}

describe('resolveFlyPrometheus', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('given both halves configured, should resolve the endpoint', () => {
    process.env.FLY_PROMETHEUS_ORG_SLUG = 'my-org';
    // The org token that drives the Machines API is reused as the metrics Bearer.
    process.env.FLY_MACHINES_ORG_TOKEN = 'tok-1';

    expect(resolveFlyPrometheus()).toEqual({ orgSlug: 'my-org', token: 'tok-1' });
  });

  it('given either half missing, should resolve NULL so the reconcile skips cleanly', () => {
    // A dark, unconfigured feature must not redden a live cron.
    process.env.FLY_PROMETHEUS_ORG_SLUG = 'my-org';
    delete process.env.FLY_MACHINES_ORG_TOKEN;
    expect(resolveFlyPrometheus()).toBeNull();

    process.env.FLY_MACHINES_ORG_TOKEN = 'tok-1';
    delete process.env.FLY_PROMETHEUS_ORG_SLUG;
    expect(resolveFlyPrometheus()).toBeNull();
  });

  it('treats a whitespace-only org slug as unconfigured', () => {
    process.env.FLY_PROMETHEUS_ORG_SLUG = '   ';
    process.env.FLY_MACHINES_ORG_TOKEN = 'tok-1';
    expect(resolveFlyPrometheus()).toBeNull();
  });
});

describe('awakeSamplesQuery', () => {
  it('counts SAMPLES rather than summing the gauge’s value', () => {
    // `sum_over_time` agrees today only because the gauge's value is 1; a future
    // value other than 1 would silently scale the answer.
    assert({
      given: 'an app name and a one-hour window',
      should: 'build a count_over_time query',
      actual: awakeSamplesQuery('pgs-app-1', 3600),
      expected: 'count_over_time(fly_instance_up{app="pgs-app-1"}[3600s])',
    });
  });

  it('escapes quotes and backslashes in the app label', () => {
    expect(awakeSamplesQuery('a"b\\c', 60)).toBe(
      'count_over_time(fly_instance_up{app="a\\"b\\\\c"}[60s])',
    );
  });

  it('floors the window at a whole positive number of seconds', () => {
    expect(awakeSamplesQuery('app', 0)).toContain('[1s]');
    expect(awakeSamplesQuery('app', -10)).toContain('[1s]');
    expect(awakeSamplesQuery('app', 90.7)).toContain('[90s]');
  });
});

describe('queryInstant', () => {
  it('sends the org-scoped instant query with a Bearer token', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ status: 'success', data: { result: [{ value: [1, '42'] }] } }),
    );

    const value = await queryInstant(config(fetchImpl as unknown as typeof fetch), 'up');

    expect(value).toBe(42);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${FLY_PROMETHEUS_BASE_URL}/my-org/api/v1/query?query=up`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
  });

  it('given a query that matched NOTHING, should return null — an ordinary answer, not an error', async () => {
    // An app that has never been woken has no series at all; reading that as a
    // failure would make every unwoken app look like a metrics outage.
    const fetchImpl = vi.fn(async () => okResponse({ status: 'success', data: { result: [] } }));

    assert({
      given: 'an empty Prometheus result set',
      should: 'be null rather than an error',
      actual: await queryInstant(config(fetchImpl as unknown as typeof fetch), 'up'),
      expected: null,
    });
  });

  it('given a non-OK HTTP status, should throw a FlyPrometheusError carrying it', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response);

    await expect(queryInstant(config(fetchImpl as unknown as typeof fetch), 'up')).rejects.toMatchObject({
      name: 'FlyPrometheusError',
      status: 503,
    });
  });

  it('given a non-success body, should throw with Prometheus’ own error text', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ status: 'error', error: 'bad query' }));

    await expect(
      queryInstant(config(fetchImpl as unknown as typeof fetch), 'up('),
    ).rejects.toBeInstanceOf(FlyPrometheusError);
  });

  it('given a non-numeric value, should return null rather than NaN', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ status: 'success', data: { result: [{ value: [1, 'NaN'] }] } }),
    );

    expect(await queryInstant(config(fetchImpl as unknown as typeof fetch), 'up')).toBeNull();
  });
});

describe('queryAwakeSeconds', () => {
  it('converts a SAMPLE COUNT into seconds via the scrape interval', async () => {
    // `count_over_time` returns a count; seconds-awake is that count times the
    // scrape interval. A stopped machine's series goes ABSENT rather than zero,
    // which is why an average would read as "up 100%" for every app.
    const fetchImpl = vi.fn(async () =>
      okResponse({ status: 'success', data: { result: [{ value: [1, '240'] }] } }),
    );

    assert({
      given: '240 scraped samples',
      should: 'price them at the scrape interval',
      actual: await queryAwakeSeconds(config(fetchImpl as unknown as typeof fetch), 'pgs-app-1', 3600),
      expected: 240 * FLY_METRICS_SCRAPE_INTERVAL_SECONDS,
    });
  });

  it('given no series, should stay null rather than becoming a zero figure', async () => {
    // Null and 0 mean different things to the drift comparison: "never seen" is
    // not "seen, and awake for no time".
    const fetchImpl = vi.fn(async () => okResponse({ status: 'success', data: { result: [] } }));

    expect(await queryAwakeSeconds(config(fetchImpl as unknown as typeof fetch), 'app', 3600)).toBeNull();
  });

  it('floors a negative sample count at 0', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ status: 'success', data: { result: [{ value: [1, '-5'] }] } }),
    );

    expect(await queryAwakeSeconds(config(fetchImpl as unknown as typeof fetch), 'app', 3600)).toBe(0);
  });
});
