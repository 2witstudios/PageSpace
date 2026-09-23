import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/lib/services/sandbox/sandbox-billing', () => ({
  defaultSandboxBillingDeps: { resolvePayerId: vi.fn(), gate: vi.fn(), releaseHold: vi.fn() },
}));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({ AIMonitoring: { trackUsage: vi.fn() } }));

import { createBrowserMeter } from '../browser-metering-adapter';
import type { UserPayerResult } from '@pagespace/lib/billing/sandbox-payer';

type MeterPrimitives = NonNullable<Parameters<typeof createBrowserMeter>[0]>;

function primitives(resolved: UserPayerResult) {
  const gate = vi.fn(async () => ({ allowed: true, holdId: 'hold-1' }));
  const releaseHold = vi.fn(async () => {});
  const trackUsage = vi.fn(async () => ({ persisted: true, creditsSettled: true }));
  const resolvePayerId = vi.fn(async () => resolved);
  const deps = { resolvePayerId, gate, releaseHold, trackUsage } as unknown as MeterPrimitives;
  return { deps, resolvePayerId, gate, releaseHold, trackUsage };
}

const billing = { driveId: 'drive-1', ownerId: 'session-owner-1', agentPageId: null, conversationId: 'conv-1' };

describe('createBrowserMeter.open', () => {
  it('holds against the resolved person before any browser starts', async () => {
    const p = primitives({ ok: true, userId: 'owner-1' });
    const meter = createBrowserMeter(p.deps);

    const opened = await meter.open(billing);

    expect(opened).toEqual({ ok: true, hold: { holdId: 'hold-1', payerId: 'owner-1' } });
    expect(p.gate).toHaveBeenCalledWith({ payerId: 'owner-1' });
  });

  it('WAL-9 (partial) refuses an ORG-drive browser by name — no wallet is gated, charged or released', async () => {
    const p = primitives({
      ok: false,
      refusal: { code: 'org_billing_pending', orgId: 'org-northwind', message: 'org billing pending' },
    });
    const meter = createBrowserMeter(p.deps);

    const opened = await meter.open(billing);

    expect(opened).toEqual({ ok: false, reason: 'org_billing_pending' });
    expect(p.gate).not.toHaveBeenCalled();
    expect(p.trackUsage).not.toHaveBeenCalled();
    expect(p.releaseHold).not.toHaveBeenCalled();
  });
});
