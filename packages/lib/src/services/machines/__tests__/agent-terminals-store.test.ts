import { describe, it, expect } from 'vitest';
import { revivedAgentTerminalColumns } from '../agent-terminals-store';

/**
 * The agent-terminal twin of `revivedBranchColumns` (sessions-per-location). A
 * re-provisioned session Sprite is a NEW generation and a fresh clone: recording
 * it must void BOTH teardown marks and RESTART the storage accounting period, so
 * a revived row never bills the dead generation's measured size for a window it
 * did not exist.
 */
describe('revivedAgentTerminalColumns', () => {
  const now = new Date('2026-07-24T12:00:00.000Z');
  const base = { sessionKey: 'pgs-agt-new', sandboxId: 'sbx-new', spriteInstanceId: 'inst-new', egressPolicyToken: 'tok', now };

  it('should record the new Sprite identity', () => {
    const columns = revivedAgentTerminalColumns(base);
    expect(columns.sessionKey).toBe('pgs-agt-new');
    expect(columns.sandboxId).toBe('sbx-new');
    expect(columns.spriteInstanceId).toBe('inst-new');
    expect(columns.egressPolicyToken).toBe('tok');
    expect(columns.updatedAt).toEqual(now);
  });

  it('should VOID both teardown marks (a new generation is not torn down, and any prior request was against the dead VM)', () => {
    const columns = revivedAgentTerminalColumns(base);
    expect(columns.spriteTornDownAt).toBeNull();
    expect(columns.teardownRequestedAt).toBeNull();
  });

  it('should RESTART the storage accounting period (fresh watermark, dropped measurement)', () => {
    const columns = revivedAgentTerminalColumns(base);
    expect(columns.storageLastBilledAt).toEqual(now);
    expect(columns.storageMeasuredBytes).toBeNull();
    expect(columns.storageMeasuredAt).toBeNull();
  });

  it('should carry a null spriteInstanceId through (the driver could not report one)', () => {
    expect(revivedAgentTerminalColumns({ ...base, spriteInstanceId: null }).spriteInstanceId).toBeNull();
  });
});
