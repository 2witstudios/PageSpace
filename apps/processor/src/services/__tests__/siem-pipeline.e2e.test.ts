/**
 * SIEM Pipeline End-to-End Test
 *
 * Drives a realistic `audit()` event through the full SIEM pipeline:
 *   audit() -> security_audit_log row -> worker poll -> mapper ->
 *   chain-verify preflight -> webhook delivery -> delivery receipt round-trip.
 *
 * Real code under test (NOT mocked):
 *   - packages/lib audit-log.ts / security-audit.ts
 *   - processor siem-event-mapper / security-audit-event-mapper
 *   - processor siem-delivery-preflight
 *   - processor siem-adapter (sendWebhook — real fetch against a local server)
 *   - processor siem-receipt-builder / siem-receipt-writer
 *   - processor siem-delivery-worker orchestration
 *
 * Stubs kept at the DB boundary only, because the processor test infra has no
 * real Postgres — the established pattern for siem-adapter/worker tests is the
 * same (see siem-adapter.test.ts, siem-delivery-worker.test.ts).
 *
 * No external network: the webhook receiver is an in-process http.createServer
 * bound to 127.0.0.1:0 (ephemeral port).
 */

import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { assert } from '../../__tests__/riteway';

describe('SIEM pipeline e2e', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('end-to-end: audit() -> worker tick -> webhook delivery -> receipt row', async () => {
    // RED skeleton — the full harness (fake HTTP receiver, mocked DB pool,
    // real audit() call, real worker tick) is not wired yet. This single
    // assertion fails so the TDD RED commit is meaningful.
    const receiptWritten = false;

    assert({
      given: 'a realistic audit() event driven through the full SIEM pipeline',
      should: 'write a siem_delivery_receipts row with delivered_at set after one worker tick',
      actual: receiptWritten,
      expected: true,
    });
  });
});
