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

    // Initialize the shared logger so its flush → drain → exit shutdown handler
    // (logging/logger.ts → createShutdownHandler) is installed at boot. That
    // handler is the single, terminating owner of graceful shutdown: on
    // SIGTERM/SIGINT it flushes buffered logs, drains the ClickHouse insert
    // buffers (up to 500 rows/table, including direct adapter inserts), then
    // exits. Initializing it here means an idle process that receives a signal
    // before serving any request still drains and terminates, rather than a
    // bespoke drain-only listener that suppresses Node's default termination
    // without ever exiting.
    await import('@pagespace/lib/logging/logger');
  }
}
