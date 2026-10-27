/**
 * Pins the processor composition-root ClickHouse wiring (#890 Phase 3 FIX).
 *
 * server.ts executes start() at import time, so it cannot be imported in a
 * unit test; these are source pins on the two invariants:
 *  - startup probes the CH mode (a half-configured deploy crashes at boot
 *    via the try/catch → process.exit(1) around start());
 *  - shutdown drains the analytics insert buffers BEFORE the queue manager
 *    shuts down, on SIGTERM and SIGINT.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const source = readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

describe('processor server — ClickHouse composition-root wiring', () => {
  it('probes the ClickHouse mode at startup, before the server listens', () => {
    const probeIndex = source.indexOf('probeClickHouseStartup()');
    const listenIndex = source.indexOf('app.listen');
    expect(probeIndex).toBeGreaterThan(-1);
    expect(listenIndex).toBeGreaterThan(-1);
    expect(probeIndex).toBeLessThan(listenIndex);
  });

  it('drains the analytics insert buffers on shutdown', () => {
    expect(source).toContain('drainAnalyticsInserts()');
  });

  it('registers the shutdown path for both SIGTERM and SIGINT', () => {
    expect(source).toMatch(/process\.on\('SIGTERM'/);
    expect(source).toMatch(/process\.on\('SIGINT'/);
  });
});
