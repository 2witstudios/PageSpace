import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn((a, b) => ({ op: 'eq', a, b })) }));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', driveId: 'pages.driveId' },
  drives: { id: 'drives.id', ownerId: 'drives.ownerId' },
}));

import { resolveSandboxPayerId, resolveAgentSessionPayerId, lookupPageOwnerId } from '../sandbox-payer';

describe('resolveSandboxPayerId', () => {
  it('falls back to tenantId when there is no backing agent page (e.g. a global-assistant run)', async () => {
    const lookup = vi.fn();
    await expect(
      resolveSandboxPayerId({ tenantId: 'owner-1', lookupPageOwnerId: lookup }),
    ).resolves.toBe('owner-1');
    expect(lookup).not.toHaveBeenCalled();
  });

  it("resolves to the referenced page's ACTUAL owner, not the acting tenantId", async () => {
    const lookup = vi.fn(async () => 'real-owner');
    await expect(
      resolveSandboxPayerId({
        tenantId: 'acting-user',
        agentPageId: 'terminal-page-1',
        lookupPageOwnerId: lookup,
      }),
    ).resolves.toBe('real-owner');
    expect(lookup).toHaveBeenCalledWith('terminal-page-1');
  });

  it('falls back to tenantId when the page/drive lookup finds no owner (orphaned page)', async () => {
    const lookup = vi.fn(async () => null);
    await expect(
      resolveSandboxPayerId({
        tenantId: 'owner-1',
        agentPageId: 'gone',
        lookupPageOwnerId: lookup,
      }),
    ).resolves.toBe('owner-1');
  });

  it('is not a passthrough — a resolved owner beats a different tenantId', async () => {
    const lookup = vi.fn(async () => 'other-owner');
    const a = await resolveSandboxPayerId({ tenantId: 'a', agentPageId: 'p', lookupPageOwnerId: lookup });
    const b = await resolveSandboxPayerId({ tenantId: 'b', agentPageId: 'p', lookupPageOwnerId: lookup });
    expect(a).toBe('other-owner');
    expect(b).toBe('other-owner');
  });
});

describe('resolveAgentSessionPayerId', () => {
  it('bills the session owner directly for a global-assistant session (null agentPageId)', async () => {
    const lookup = vi.fn();
    await expect(
      resolveAgentSessionPayerId({ ownerId: 'owner-1', agentPageId: null, lookupPageOwnerId: lookup }),
    ).resolves.toBe('owner-1');
    expect(lookup).not.toHaveBeenCalled();
  });

  it("resolves to the agent page's ACTUAL page owner when agentPageId is set", async () => {
    const lookup = vi.fn(async () => 'real-owner');
    await expect(
      resolveAgentSessionPayerId({ ownerId: 'owner-1', agentPageId: 'agent-page-1', lookupPageOwnerId: lookup }),
    ).resolves.toBe('real-owner');
    expect(lookup).toHaveBeenCalledWith('agent-page-1');
  });

  it('falls back to the session ownerId when the agent page/drive lookup finds no owner (orphaned page)', async () => {
    const lookup = vi.fn(async () => null);
    await expect(
      resolveAgentSessionPayerId({ ownerId: 'owner-1', agentPageId: 'gone', lookupPageOwnerId: lookup }),
    ).resolves.toBe('owner-1');
  });

  it('is not a passthrough — a resolved owner beats a different ownerId', async () => {
    const lookup = vi.fn(async () => 'other-owner');
    const a = await resolveAgentSessionPayerId({ ownerId: 'a', agentPageId: 'p', lookupPageOwnerId: lookup });
    const b = await resolveAgentSessionPayerId({ ownerId: 'b', agentPageId: 'p', lookupPageOwnerId: lookup });
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
