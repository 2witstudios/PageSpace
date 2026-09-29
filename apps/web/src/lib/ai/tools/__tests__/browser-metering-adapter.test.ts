import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/lib/services/sandbox/sandbox-billing', () => ({
  defaultSandboxBillingDeps: { resolveCharge: vi.fn(), gate: vi.fn(), releaseHold: vi.fn() },
}));
vi.mock('@pagespace/lib/billing/compute-gate', () => ({ computeSettleWalletId: vi.fn() }));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({ AIMonitoring: { trackUsage: vi.fn() } }));

import { createBrowserMeter } from '../browser-metering-adapter';
import { ORG_COMPUTE_REFUSAL_MESSAGES, type ComputeCharge } from '@pagespace/lib/billing/compute-charge';

type MeterPrimitives = NonNullable<Parameters<typeof createBrowserMeter>[0]>;
type GateAnswer = Awaited<ReturnType<MeterPrimitives['gate']>>;

function primitives(charge: ComputeCharge, gateAnswer: GateAnswer = { allowed: true, holdId: 'hold-1' }, settleWalletId: string | null | undefined = undefined) {
  const gate = vi.fn(async () => gateAnswer);
  const releaseHold = vi.fn(async () => {});
  const trackUsage = vi.fn(async () => ({ persisted: true, creditsSettled: true }));
  const resolveCharge = vi.fn(async () => charge);
  const settle = vi.fn(async () => settleWalletId);
  const deps = { resolveCharge, gate, releaseHold, trackUsage, settleWalletId: settle } as unknown as MeterPrimitives;
  return { deps, resolveCharge, gate, releaseHold, trackUsage, settle };
}

const billing = { driveId: 'drive-1', ownerId: 'session-owner-1', agentPageId: null, conversationId: 'conv-1' };
const shape = { cpus: 2, memoryGB: 2 };
const orgCharge: ComputeCharge = { kind: 'org', orgId: 'org-northwind', userId: 'session-owner-1' };

describe('createBrowserMeter.open', () => {
  it('holds against the resolved person before any browser starts', async () => {
    const p = primitives({ kind: 'user', userId: 'owner-1' });
    const meter = createBrowserMeter(p.deps);

    const opened = await meter.open(billing);

    expect(opened).toEqual({ ok: true, hold: { holdId: 'hold-1', charge: { kind: 'user', userId: 'owner-1' } } });
    expect(p.gate).toHaveBeenCalledWith({ charge: { kind: 'user', userId: 'owner-1' } });
  });

  it('WAL-9 (partial) an ORG-drive browser is held on the org pool charge, not on any person', async () => {
    const p = primitives(orgCharge);
    const meter = createBrowserMeter(p.deps);

    const opened = await meter.open(billing);

    expect(opened).toEqual({ ok: true, hold: { holdId: 'hold-1', charge: orgCharge } });
    expect(p.gate).toHaveBeenCalledWith({ charge: orgCharge });
  });

  it('WAL-9 (partial) an empty org pool refuses the browser with the org message — nothing is charged', async () => {
    const p = primitives(orgCharge, { allowed: false, reason: 'org_wallet_empty', orgRefusal: 'org_wallet_empty' });
    const meter = createBrowserMeter(p.deps);

    const opened = await meter.open(billing);

    expect(opened).toEqual({ ok: false, reason: ORG_COMPUTE_REFUSAL_MESSAGES.org_wallet_empty });
    expect(p.trackUsage).not.toHaveBeenCalled();
  });
});

describe('createBrowserMeter.close', () => {
  it('WAL-9 (partial) settles an org-drive browser against the org pool wallet, recorded under the session owner', async () => {
    const p = primitives(orgCharge, undefined, 'pool-wallet-1');
    const meter = createBrowserMeter(p.deps);

    await meter.close({ billing, hold: { holdId: 'hold-1', charge: orgCharge }, activeSeconds: 60, shape, substrate: 'sprites' });

    expect(p.trackUsage).toHaveBeenCalledWith(expect.objectContaining({ userId: 'session-owner-1', walletId: 'pool-wallet-1', holdId: 'hold-1' }));
  });

  it('WAL-9 (partial) an org pool gone since the hold settles nothing and releases the hold — never onto the person', async () => {
    const p = primitives(orgCharge, undefined, null);
    const meter = createBrowserMeter(p.deps);

    await meter.close({ billing, hold: { holdId: 'hold-1', charge: orgCharge }, activeSeconds: 60, shape, substrate: 'sprites' });

    expect(p.trackUsage).not.toHaveBeenCalled();
    expect(p.releaseHold).toHaveBeenCalledWith('hold-1');
  });

  it('a personal browser settles with no wallet override (the personal root)', async () => {
    const p = primitives({ kind: 'user', userId: 'owner-1' });
    const meter = createBrowserMeter(p.deps);

    await meter.close({ billing, hold: { holdId: 'hold-1', charge: { kind: 'user', userId: 'owner-1' } }, activeSeconds: 60, shape, substrate: 'sprites' });

    expect(p.trackUsage).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner-1', walletId: undefined }));
  });
});
