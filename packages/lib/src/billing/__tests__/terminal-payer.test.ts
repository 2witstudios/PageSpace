import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn((a, b) => ({ op: 'eq', a, b })) }));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', driveId: 'pages.driveId' },
  drives: { id: 'drives.id', ownerId: 'drives.ownerId' },
}));

import { resolveTerminalPayerId, lookupPageOwnerId } from '../terminal-payer';

describe('resolveTerminalPayerId', () => {
  it('falls back to tenantId when there is no backing machine page (e.g. an own machine with no active page yet)', async () => {
    const lookup = vi.fn();
    await expect(
      resolveTerminalPayerId({ tenantId: 'owner-1', lookupPageOwnerId: lookup }),
    ).resolves.toBe('owner-1');
    expect(lookup).not.toHaveBeenCalled();
  });

  it("resolves to the referenced machine's ACTUAL page owner, not the acting tenantId", async () => {
    const lookup = vi.fn(async () => 'real-owner');
    await expect(
      resolveTerminalPayerId({
        tenantId: 'acting-user',
        machinePageId: 'terminal-page-1',
        lookupPageOwnerId: lookup,
      }),
    ).resolves.toBe('real-owner');
    expect(lookup).toHaveBeenCalledWith('terminal-page-1');
  });

  it('falls back to tenantId when the page/drive lookup finds no owner (orphaned page)', async () => {
    const lookup = vi.fn(async () => null);
    await expect(
      resolveTerminalPayerId({
        tenantId: 'owner-1',
        machinePageId: 'gone',
        lookupPageOwnerId: lookup,
      }),
    ).resolves.toBe('owner-1');
  });

  it('is not a passthrough — a resolved owner beats a different tenantId', async () => {
    const lookup = vi.fn(async () => 'other-owner');
    const a = await resolveTerminalPayerId({ tenantId: 'a', machinePageId: 'p', lookupPageOwnerId: lookup });
    const b = await resolveTerminalPayerId({ tenantId: 'b', machinePageId: 'p', lookupPageOwnerId: lookup });
    expect(a).toBe('other-owner');
    expect(b).toBe('other-owner');
  });
});

describe('lookupPageOwnerId (real pages -> drives join)', () => {
  beforeEach(() => mockDb.select.mockReset());

  it('joins pages -> drives and returns the drive ownerId', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            limit: async () => [{ ownerId: 'owner-42' }],
          }),
        }),
      }),
    });
    await expect(lookupPageOwnerId('page-1')).resolves.toBe('owner-42');
  });

  it('returns null when the page has no row', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    });
    await expect(lookupPageOwnerId('missing')).resolves.toBeNull();
  });
});
