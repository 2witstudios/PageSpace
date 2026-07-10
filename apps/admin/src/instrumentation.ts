/**
 * Admin composition root (Next.js instrumentation hook).
 *
 * ClickHouse analytics wiring (#890 Phase 3): this process both reads the
 * analytics tier (monitoring queries) and writes to it (logger-database →
 * insert adapters), so it must fail-fast on a half-configured deploy — the
 * adapters absorb per-row errors by design, and a running process with the
 * flag on but creds missing would silently black out all 4 tables. It must
 * also drain the insert buffers on shutdown so deploys don't lose the
 * in-memory window (up to 500 rows/table).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { probeClickHouseStartup } = await import('@pagespace/lib/observability/clickhouse-client');
    const chMode = probeClickHouseStartup();
    console.log(`[Instrumentation] ClickHouse analytics tier: ${chMode.mode}`);

    const { drainAnalyticsInserts } = await import('@pagespace/lib/observability/analytics-inserts');
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        void drainAnalyticsInserts();
      });
    }
  }
}
