import { describe, it, expect, vi, beforeEach } from 'vitest';

// -------------------------------------------------------------------------
// Mocks — must be hoisted before imports
// -------------------------------------------------------------------------

const mockExpandMentions = vi.fn();
vi.mock('../expand-group-mentions', () => ({
  expandMentionsToUserIds: (...args: unknown[]) => mockExpandMentions(...args),
}));

const mockCanUserViewPage = vi.fn();
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: (...args: unknown[]) => mockCanUserViewPage(...args),
}));

const mockCreateMentionNotification = vi.fn();
vi.mock('@pagespace/lib/notifications/notifications', () => ({
  createMentionNotification: (...args: unknown[]) => mockCreateMentionNotification(...args),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    realtime: { error: vi.fn(), warn: vi.fn() },
    ai: { error: vi.fn(), warn: vi.fn() },
  },
}));

// -------------------------------------------------------------------------
// Import after mocks
// -------------------------------------------------------------------------

import { notifyMentionedUsers } from '../notify-mentioned-users';

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockExpandMentions.mockResolvedValue([]);
  mockCanUserViewPage.mockResolvedValue(true);
  mockCreateMentionNotification.mockResolvedValue({ id: 'notif-1' });
});

describe('notifyMentionedUsers', () => {
  it('excludes triggeredByUserId from notification targets', async () => {
    mockExpandMentions.mockResolvedValue(['invoker', 'other']);

    await notifyMentionedUsers({
      content: '@[Invoker](invoker:user) @[Other](other:user)',
      pageId: 'page-1',
      driveId: 'drive-1',
      triggeredByUserId: 'invoker',
    });

    expect(mockCreateMentionNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateMentionNotification).toHaveBeenCalledWith(
      'other',
      'page-1',
      'invoker',
      undefined
    );
  });

  it('filters out users who cannot view the page', async () => {
    mockExpandMentions.mockResolvedValue(['alice', 'bob']);
    mockCanUserViewPage.mockImplementation(async (userId: string) => userId === 'alice');

    await notifyMentionedUsers({
      content: 'hello',
      pageId: 'page-1',
      driveId: 'drive-1',
      triggeredByUserId: 'someone-else',
    });

    expect(mockCreateMentionNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateMentionNotification).toHaveBeenCalledWith(
      'alice',
      'page-1',
      'someone-else',
      undefined
    );
  });

  it('passes mentionerNameOverride through to createMentionNotification', async () => {
    mockExpandMentions.mockResolvedValue(['target']);

    await notifyMentionedUsers({
      content: '@[Target](target:user)',
      pageId: 'page-1',
      driveId: 'drive-1',
      triggeredByUserId: 'agent-user',
      mentionerNameOverride: 'ResearchBot',
    });

    expect(mockCreateMentionNotification).toHaveBeenCalledWith(
      'target',
      'page-1',
      'agent-user',
      { mentionerNameOverride: 'ResearchBot' }
    );
  });

  it('never throws even when createMentionNotification rejects', async () => {
    mockExpandMentions.mockResolvedValue(['target']);
    mockCreateMentionNotification.mockRejectedValue(new Error('DB failure'));

    await expect(
      notifyMentionedUsers({
        content: '@[Target](target:user)',
        pageId: 'page-1',
        driveId: 'drive-1',
        triggeredByUserId: 'user-x',
      })
    ).resolves.toBeUndefined();
  });

  it('never throws even when expandMentionsToUserIds rejects', async () => {
    mockExpandMentions.mockRejectedValue(new Error('Expand failure'));

    await expect(
      notifyMentionedUsers({
        content: '@[Target](target:user)',
        pageId: 'page-1',
        driveId: 'drive-1',
        triggeredByUserId: 'user-x',
      })
    ).resolves.toBeUndefined();
  });

  it('does nothing when no mentions are found', async () => {
    mockExpandMentions.mockResolvedValue([]);

    await notifyMentionedUsers({
      content: 'no mentions here',
      pageId: 'page-1',
      driveId: 'drive-1',
      triggeredByUserId: 'user-x',
    });

    expect(mockCreateMentionNotification).not.toHaveBeenCalled();
  });
});
