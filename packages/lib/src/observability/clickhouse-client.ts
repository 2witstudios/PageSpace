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
 *   misconfigured  → throw (flag on but config missing/invalid — fail fast,
 *                    never silently drop inserts)
 */
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import {
  isClickHouseEnabledFlag,
  resolveClickHouseMode,
  type ClickHouseClientConfig,
  type ClickHouseEnv,
  type ClickHouseModeDecision,
} from './clickhouse-env';

export {
  isClickHouseEnabledFlag,
  resolveClickHouseMode,
  type ClickHouseClientConfig,
  type ClickHouseEnv,
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
  /** Resolved-mode readback without init side effects — never constructs, never throws. */
  getMode: () => ClickHouseModeDecision;
}

export function createClickHouseRegistry(deps: ClickHouseRegistryDeps): ClickHouseRegistry {
  let instance: ClickHouseClient | null = null;

  return {
    getClient(): ClickHouseClient | null {
      if (instance) return instance;
      const decision = resolveClickHouseMode(deps.getEnv());
      switch (decision.mode) {
        case 'disabled':
          return null;
        case 'enabled':
          instance = deps.createClient(decision.config);
          return instance;
        case 'misconfigured':
          throw new Error(`ClickHouse client init failed: ${decision.reason}`);
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

/** Resolved analytics-tier mode for the current process env. Side-effect free. */
export const getClickHouseMode = (): ClickHouseModeDecision =>
  registry.getMode();

/** True only when CLICKHOUSE_ENABLED is exactly 'true' (fail-closed). */
export const isClickHouseEnabled = (): boolean =>
  isClickHouseEnabledFlag(process.env.CLICKHOUSE_ENABLED);
