/**
 * Pure decision logic for the ClickHouse analytics tier (#890 Phase 3).
 * No I/O, no process.env reads — callers pass env values in. Mirrors the
 * Admin PG three-state contract (packages/db/src/admin-db-mode.ts):
 *
 *   CLICKHOUSE_ENABLED not exactly 'true'            → 'disabled' (default —
 *     the 4 analytics tables keep writing to the main PG unchanged)
 *   flag on + connection config resolvable           → 'enabled'
 *   flag on + config missing/invalid                 → 'misconfigured' (the
 *     client shell throws at init — never silently drop inserts)
 *
 * Credentials are server-side secrets: they never reach the browser and
 * .env.example carries placeholders only.
 */

export interface ClickHouseEnv {
  CLICKHOUSE_ENABLED?: string | undefined;
  CLICKHOUSE_URL?: string | undefined;
  CLICKHOUSE_HOST?: string | undefined;
  CLICKHOUSE_USER?: string | undefined;
  CLICKHOUSE_PASSWORD?: string | undefined;
  CLICKHOUSE_DATABASE?: string | undefined;
}

export type ClickHouseModeName = 'disabled' | 'enabled' | 'misconfigured';

/** Connection config consumed by @clickhouse/client's createClient. */
export interface ClickHouseClientConfig {
  url: string;
  username: string;
  password: string;
  database: string;
}

export type ClickHouseModeDecision =
  | { mode: 'disabled'; reason: string }
  | { mode: 'enabled'; reason: string; config: ClickHouseClientConfig }
  | { mode: 'misconfigured'; reason: string };

// Fail-closed: only the exact string 'true' enables. 'TRUE', '1', ' true ',
// '' etc. do not — mirrors CODE_EXECUTION_ENABLED and ADMIN_DB_BREAK_GLASS.
export const isClickHouseEnabledFlag = (flag: string | undefined): boolean =>
  flag === 'true';

const isHttpUrl = (value: string): boolean =>
  value.startsWith('http://') || value.startsWith('https://');

const hasScheme = (value: string): boolean => value.includes('://');

// ClickHouse Cloud serves HTTPS on 8443; a bare hostname resolves there.
// Anything with an explicit scheme must be http(s) — the JS client speaks
// the HTTP interface only (never the native 9000 port).
const resolveUrl = (host: string): { url: string } | { error: string } => {
  if (!hasScheme(host)) return { url: `https://${host}:8443` };
  if (isHttpUrl(host)) return { url: host };
  return {
    error: `must be an http:// or https:// URL or a bare hostname (got a non-http scheme)`,
  };
};

const isSet = (value: string | undefined): value is string =>
  value !== undefined && value !== '';

export const resolveClickHouseMode = (env: ClickHouseEnv): ClickHouseModeDecision => {
  if (!isClickHouseEnabledFlag(env.CLICKHOUSE_ENABLED)) {
    return {
      mode: 'disabled',
      reason:
        "CLICKHOUSE_ENABLED is not 'true' — the analytics tier is off; the 4 analytics tables keep writing to the main PG",
    };
  }

  const username = env.CLICKHOUSE_USER;
  const password = env.CLICKHOUSE_PASSWORD;
  const database = env.CLICKHOUSE_DATABASE;
  const source = isSet(env.CLICKHOUSE_URL)
    ? { name: 'CLICKHOUSE_URL' as const, value: env.CLICKHOUSE_URL }
    : isSet(env.CLICKHOUSE_HOST)
      ? { name: 'CLICKHOUSE_HOST' as const, value: env.CLICKHOUSE_HOST }
      : undefined;

  // Report everything missing in one pass so a misconfigured deploy is fixed
  // in one iteration, not one env var at a time.
  if (!source || !isSet(username) || !isSet(password) || !isSet(database)) {
    const missing = [
      !source && 'CLICKHOUSE_HOST (or CLICKHOUSE_URL)',
      !isSet(username) && 'CLICKHOUSE_USER',
      !isSet(password) && 'CLICKHOUSE_PASSWORD',
      !isSet(database) && 'CLICKHOUSE_DATABASE',
    ].filter((name): name is string => typeof name === 'string');
    return {
      mode: 'misconfigured',
      reason: `CLICKHOUSE_ENABLED='true' but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. Set the missing config or turn the flag off.`,
    };
  }

  const resolved =
    source.name === 'CLICKHOUSE_URL'
      ? isHttpUrl(source.value)
        ? { url: source.value }
        : { error: 'must be an http:// or https:// URL' }
      : resolveUrl(source.value);
  if ('error' in resolved) {
    return {
      mode: 'misconfigured',
      reason: `${source.name} ${resolved.error}.`,
    };
  }

  return {
    mode: 'enabled',
    reason: `CLICKHOUSE_ENABLED='true' with connection config from ${source.name}`,
    config: { url: resolved.url, username, password, database },
  };
};
