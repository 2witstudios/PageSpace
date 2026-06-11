import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      commands: { findMany: vi.fn() },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
}));
vi.mock('@pagespace/db/schema/commands', () => ({
  commands: { id: 'id', userId: 'userId', driveId: 'driveId', enabled: 'enabled' },
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn(),
}));

import { db } from '@pagespace/db/db';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { loadAvailableCommands } from '../available-commands';

const mockFindMany = db.query.commands.findMany as unknown as Mock;
const mockCanUserViewPage = vi.mocked(canUserViewPage);

const USER_ID = 'usr9zmbrgj3atz4a98xxat96';
const DRIVE_ID = 'drv9zmbrgj3atz4a98xxat96';

const personalRow = (trigger: string, overrides: Record<string, unknown> = {}) => ({
  id: `user-${trigger}`,
  userId: USER_ID,
  driveId: null,
  trigger,
  description: `Personal ${trigger}`,
  entryPageId: `page-${trigger}`,
  type: 'document',
  enabled: true,
  entryPage: { driveId: 'whatever-drive', isTrashed: false },
  ...overrides,
});

const driveRow = (trigger: string, overrides: Record<string, unknown> = {}) => ({
  id: `drive-${trigger}`,
  userId: null,
  driveId: DRIVE_ID,
  trigger,
  description: `Drive ${trigger}`,
  entryPageId: `page-${trigger}`,
  type: 'document',
  enabled: true,
  entryPage: { driveId: DRIVE_ID, isTrashed: false },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockFindMany.mockResolvedValue([]);
  mockCanUserViewPage.mockResolvedValue(true);
});

describe('loadAvailableCommands', () => {
  it('returns built-ins plus the personal commands when there is no drive context', async () => {
    mockFindMany.mockResolvedValueOnce([personalRow('release-checklist')]);

    const { winners } = await loadAvailableCommands(USER_ID, null);

    expect(winners.map((w) => w.trigger).sort()).toEqual(['help', 'release-checklist']);
    expect(winners.find((w) => w.trigger === 'help')).toMatchObject({
      id: 'builtin:help',
      scope: 'builtin',
      type: 'builtin',
    });
    expect(winners.find((w) => w.trigger === 'release-checklist')).toMatchObject({
      scope: 'user',
      description: 'Personal release-checklist',
    });
    // Without a drive there must be exactly one DB query (personal commands)
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it('includes drive commands when a (membership-verified) driveId is given', async () => {
    mockFindMany
      .mockResolvedValueOnce([personalRow('mine')])
      .mockResolvedValueOnce([driveRow('ours')]);

    const { winners } = await loadAvailableCommands(USER_ID, DRIVE_ID);

    expect(winners.map((w) => w.trigger).sort()).toEqual(['help', 'mine', 'ours']);
    expect(winners.find((w) => w.trigger === 'ours')).toMatchObject({
      scope: 'drive',
      driveId: DRIVE_ID,
    });
    expect(mockFindMany).toHaveBeenCalledTimes(2);
  });

  it('suppresses commands whose entry page is trashed or missing', async () => {
    mockFindMany
      .mockResolvedValueOnce([
        personalRow('live'),
        personalRow('trashed', { entryPage: { driveId: 'x', isTrashed: true } }),
        personalRow('orphan', { entryPage: null }),
      ])
      .mockResolvedValueOnce([]);

    const { winners } = await loadAvailableCommands(USER_ID, DRIVE_ID);

    expect(winners.map((w) => w.trigger).sort()).toEqual(['help', 'live']);
  });

  it('suppresses drive commands whose entry page moved to another drive', async () => {
    mockFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        driveRow('stayed'),
        driveRow('moved', { entryPage: { driveId: 'other-drive', isTrashed: false } }),
      ]);

    const { winners } = await loadAvailableCommands(USER_ID, DRIVE_ID);

    expect(winners.map((w) => w.trigger).sort()).toEqual(['help', 'stayed']);
  });

  it('suppresses commands whose entry page the user cannot view (execution-time predicate)', async () => {
    mockFindMany
      .mockResolvedValueOnce([personalRow('visible'), personalRow('hidden')])
      .mockResolvedValueOnce([driveRow('drive-visible'), driveRow('drive-hidden')]);
    mockCanUserViewPage.mockImplementation(
      async (_userId: string, pageId: string) => !pageId.includes('hidden')
    );

    const { winners } = await loadAvailableCommands(USER_ID, DRIVE_ID);

    expect(winners.map((w) => w.trigger).sort()).toEqual(['drive-visible', 'help', 'visible']);
    // The check runs with the requesting user's identity
    expect(mockCanUserViewPage).toHaveBeenCalledWith(USER_ID, 'page-hidden');
  });

  it('does not run entry-page access checks for built-ins (they have no entry page)', async () => {
    const { winners } = await loadAvailableCommands(USER_ID, null);
    expect(winners.map((w) => w.trigger)).toEqual(['help']);
    expect(mockCanUserViewPage).not.toHaveBeenCalled();
  });

  it('resolves trigger collisions with builtin > user > drive precedence', async () => {
    mockFindMany
      .mockResolvedValueOnce([personalRow('help'), personalRow('deploy')])
      .mockResolvedValueOnce([driveRow('deploy')]);

    const { winners, shadowed } = await loadAvailableCommands(USER_ID, DRIVE_ID);

    const help = winners.find((w) => w.trigger === 'help');
    expect(help?.scope).toBe('builtin');
    const deploy = winners.find((w) => w.trigger === 'deploy');
    expect(deploy?.scope).toBe('user');
    expect(deploy?.shadows).toBe('drive');
    expect(shadowed.map((s) => `${s.scope}:${s.trigger}`).sort()).toEqual([
      'drive:deploy',
      'user:help',
    ]);
  });
});
