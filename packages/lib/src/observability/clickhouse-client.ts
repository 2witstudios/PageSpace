/**
 * ClickHouse client shell for the analytics tier (#890 Phase 3).
 *
 * Composition root mirroring adminDb (packages/db/src/admin-db.ts): mode
 * selection is pure (clickhouse-env.ts); this shell only constructs the
 * @clickhouse/client instance and wires deps. Init is lazy — importing this
 * module opens no connection and reads no env.
 *
 * Three-state contract at getClient():
 *   disabled       → null (default; zero behavior change, PG writes continue)
 *   enabled        → client, constructed once per process
 *   misconfigured  → throw ClickHouseMisconfiguredError (flag on but config
 *                    missing/invalid — fail fast, never silently drop inserts)
 *
 * getGdprClient() answers a different question — where subject data COULD
 * live, independent of the write-cutover flag — so a flag rollback never
 * orphans CH rows from Art 15 export / Art 17 erasure:
 *   unconfigured   → null (no CH env at all; rows can only be in main PG)
 *   configured     → client, even when CLICKHOUSE_ENABLED is off
 *   misconfigured  → throw (partial config — GDPR must not skip a store that
 *                    may hold subject rows)
 */
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import {
  ClickHouseMisconfiguredError,
  isClickHouseEnabledFlag,
  resolveClickHouseGdprMode,
  resolveClickHouseMode,
  type ClickHouseClientConfig,
  type ClickHouseEnv,
  type ClickHouseModeDecision,
} from './clickhouse-env';

export {
  ClickHouseMisconfiguredError,
  isClickHouseEnabledFlag,
  resolveClickHouseGdprMode,
  resolveClickHouseMode,
  type ClickHouseClientConfig,
  type ClickHouseEnv,
  type ClickHouseGdprModeDecision,
  type ClickHouseModeDecision,
  type ClickHouseModeName,
} from './clickhouse-env';
export type { ClickHouseClient } from '@clickhouse/client';

export interface ClickHouseRegistryDeps {
  getEnv: () => ClickHouseEnv;
  createClient: (config: ClickHouseClientConfig) => ClickHouseClient;
}

export interface ClickHouseRegistry {
  getClient: () => ClickHouseClient | null;
  /**
   * GDPR accessor: a client whenever connection config is resolvable (flag
   * irrelevant), null only when no CH env exists at all, throw on partial
   * config. Shares the per-process instance with getClient().
   */
  getGdprClient: () => ClickHouseClient | null;
  /** Resolved-mode readback without init side effects — never constructs, never throws. */
  getMode: () => ClickHouseModeDecision;
}

export function createClickHouseRegistry(deps: ClickHouseRegistryDeps): ClickHouseRegistry {
  let instance: ClickHouseClient | null = null;

  // Both accessors resolve config from the same env vars, so whichever runs
  // first constructs the single per-process instance.
  const construct = (config: ClickHouseClientConfig): ClickHouseClient => {
    if (!instance) instance = deps.createClient(config);
    return instance;
  };

  return {
    getClient(): ClickHouseClient | null {
      if (instance) return instance;
      const decision = resolveClickHouseMode(deps.getEnv());
      switch (decision.mode) {
        case 'disabled':
          return null;
        case 'enabled':
          return construct(decision.config);
        case 'misconfigured':
          throw new ClickHouseMisconfiguredError(`client init failed: ${decision.reason}`);
      }
    },
    getGdprClient(): ClickHouseClient | null {
      const decision = resolveClickHouseGdprMode(deps.getEnv());
      switch (decision.mode) {
        case 'unconfigured':
          return null;
        case 'configured':
          return construct(decision.config);
        case 'misconfigured':
          throw new ClickHouseMisconfiguredError(`GDPR client unavailable: ${decision.reason}`);
      }
    },
    getMode() {
      return resolveClickHouseMode(deps.getEnv());
    },
  };
}

const registry = createClickHouseRegistry({
  // Env is read at init time, not import time, so late-loaded dotenv wins.
  getEnv: () => ({
    CLICKHOUSE_ENABLED: process.env.CLICKHOUSE_ENABLED,
    CLICKHOUSE_URL: process.env.CLICKHOUSE_URL,
    CLICKHOUSE_HOST: process.env.CLICKHOUSE_HOST,
    CLICKHOUSE_USER: process.env.CLICKHOUSE_USER,
    CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD,
    CLICKHOUSE_DATABASE: process.env.CLICKHOUSE_DATABASE,
  }),
  createClient: (config) => createClient(config),
});

/**
 * Per-process ClickHouse client accessor. Lazy: constructs (or returns null
 * when the tier is off, or throws on misconfiguration) on first call, then
 * returns the same instance for the process lifetime.
 */
export const getClickHouseClient = (): ClickHouseClient | null => registry.getClient();

/**
 * GDPR client accessor: reaches CH wherever subject data COULD live —
 * configured at all (even with the write flag off) → client; nothing set →
 * null; partial config → throw. Export/erasure paths use this, never
 * getClickHouseClient (#890 Phase 3 FIX, flag-rollback fail-open).
 */
export const getClickHouseGdprClient = (): ClickHouseClient | null => registry.getGdprClient();

/** Resolved analytics-tier mode for the current process env. Side-effect free. */
export const getClickHouseMode = (): ClickHouseModeDecision =>
  registry.getMode();

/** True only when CLICKHOUSE_ENABLED is exactly 'true' (fail-closed). */
export const isClickHouseEnabled = (): boolean =>
  isClickHouseEnabledFlag(process.env.CLICKHOUSE_ENABLED);

/**
 * True when the CH analytics store is (or could be) in play for subject data
 * — any connection config or the flag present. Drives GDPR-critical
 * decisions such as making the erasure purge step fatal.
 */
export const isClickHouseAnalyticsInPlay = (): boolean =>
  resolveClickHouseGdprMode({
    CLICKHOUSE_ENABLED: process.env.CLICKHOUSE_ENABLED,
    CLICKHOUSE_URL: process.env.CLICKHOUSE_URL,
    CLICKHOUSE_HOST: process.env.CLICKHOUSE_HOST,
    CLICKHOUSE_USER: process.env.CLICKHOUSE_USER,
    CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD,
    CLICKHOUSE_DATABASE: process.env.CLICKHOUSE_DATABASE,
  }).mode !== 'unconfigured';

/**
 * Startup probe for composition roots (web/admin instrumentation, processor
 * server): a half-configured deploy (flag on, config missing) must CRASH the
 * process at boot, not silently black out telemetry while enqueue() absorbs
 * per-row errors (#890 Phase 3 FIX). Returns the decision for startup logs.
 */
export const probeClickHouseStartup = (): ClickHouseModeDecision => {
  const decision = registry.getMode();
  if (decision.mode === 'misconfigured') {
    throw new ClickHouseMisconfiguredError(`startup probe failed: ${decision.reason}`);
  }
  return decision;
};
