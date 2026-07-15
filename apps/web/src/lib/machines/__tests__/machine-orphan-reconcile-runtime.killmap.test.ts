/**
 * Unit test for the ONE piece of `machine-orphan-reconcile-runtime` that is pure
 * mapping logic rather than SQL: how `killSprite` translates the host's kill
 * outcomes into the reconciler's `{ ok }` contract. The real-Postgres integration
 * suite covers the queries and CAS writes; this covers the error classification,
 * which a DB fixture cannot reach (it needs the host to throw specific errors).
 */
import { describe, it, expect, vi } from 'vitest';

const { mockKill } = vi.hoisted(() => ({ mockKill: vi.fn() }));

vi.mock('../machine-branches-runtime', () => ({
  getMachineHostForBranches: vi.fn(async () => ({ kill: mockKill })),
}));

import { MachineSpriteReplacedError } from '@pagespace/lib/services/sandbox/machine-host';
import { defaultReconcileOrphanSpritesDeps } from '../machine-orphan-reconcile-runtime';

describe('defaultReconcileOrphanSpritesDeps.killSprite — outcome mapping', () => {
  it('maps a clean kill to ok', async () => {
    mockKill.mockResolvedValueOnce(undefined);

    const result = await defaultReconcileOrphanSpritesDeps.killSprite({
      sandboxId: 'pgs-sbx-1',
      spriteInstanceId: 'inst-1',
    });

    expect(result).toEqual({ ok: true });
    expect(mockKill).toHaveBeenCalledWith({ machineId: 'pgs-sbx-1', expectedInstanceId: 'inst-1' });
  });

  it('maps a REPLACED sprite to ok — the target is gone, so the row must be RELEASED, not retried forever', async () => {
    // This is the stuck-row bug the mapping exists to prevent: a
    // MachineSpriteReplacedError means a different live VM holds the name now, so
    // our target is already dead. Reporting failure would retry the outbox row
    // every tick (growing `attempts`) against a VM that no longer exists and could
    // never drop the pointer. The live newcomer has its own fresh tracking row, so
    // releasing ours never orphans it.
    mockKill.mockRejectedValueOnce(new MachineSpriteReplacedError('pgs-sbx-1', 'inst-dead', 'inst-live'));

    const result = await defaultReconcileOrphanSpritesDeps.killSprite({
      sandboxId: 'pgs-sbx-1',
      spriteInstanceId: 'inst-dead',
    });

    expect(result).toEqual({ ok: true });
  });

  it('maps any OTHER failure to a reported failure — the target may still be alive, so keep the pointer', async () => {
    const error = new Error('sprite host unreachable');
    mockKill.mockRejectedValueOnce(error);

    const result = await defaultReconcileOrphanSpritesDeps.killSprite({
      sandboxId: 'pgs-sbx-1',
      spriteInstanceId: 'inst-1',
    });

    expect(result).toEqual({ ok: false, error });
  });

  it('passes undefined (not null) as expectedInstanceId for a legacy row with no instance id', async () => {
    mockKill.mockResolvedValueOnce(undefined);

    await defaultReconcileOrphanSpritesDeps.killSprite({ sandboxId: 'pgs-sbx-1', spriteInstanceId: null });

    expect(mockKill).toHaveBeenCalledWith({ machineId: 'pgs-sbx-1', expectedInstanceId: undefined });
  });
});
