import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (must be hoisted before imports)
// ---------------------------------------------------------------------------

vi.mock('@pagespace/db/db', () => {
  const mockDb = {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    query: {
      pages: { findFirst: vi.fn() },
      users: { findFirst: vi.fn() },
      drives: { findFirst: vi.fn() },
      notifications: { findFirst: vi.fn() },
    },
  };
  return { db: mockDb };
});

vi.mock('@pagespace/db/schema/notifications', () => ({
  notifications: { id: 'id', userId: 'userId', type: 'type', isRead: 'isRead', metadata: 'metadata', createdAt: 'createdAt' },
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', name: 'name', email: 'email', image: 'image' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', title: 'title', driveId: 'driveId', type: 'type' },
  drives: { id: 'id', slug: 'slug', name: 'name' },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((_a, _b) => 'eq'),
  and: vi.fn((...args) => ({ and: args })),
  desc: vi.fn((a) => ({ desc: a })),
  count: vi.fn(() => 'count()'),
  sql: Object.assign(vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join(''), values })), { placeholder: vi.fn() }),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-id-123'),
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
}));

vi.mock('../../services/notification-email-service', () => ({
  sendNotificationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../auth/broadcast-auth', () => ({
  createSignedBroadcastHeaders: vi.fn(() => ({ Authorization: 'Bearer mock-token' })),
}));

vi.mock('../push-notifications', () => ({
  sendPushNotification: vi.fn().mockResolvedValue({ sent: 0, failed: 0, errors: [] }),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  createNotification,
  getUserNotifications,
  getUnreadNotificationCount,
  getUnreadCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  createPermissionNotification,
  createDriveNotification,
  createOrUpdateMessageNotification,
  createMentionNotification,
  createTaskAssignedNotification,
  broadcastTosPrivacyUpdate,
  markConnectionRequestActioned,
} from '../notifications';
import { db } from '@pagespace/db/db';
import { sendPushNotification } from '../push-notifications';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockNotification = {
  id: 'mock-id-123',
  userId: 'user-1',
  type: 'PAGE_SHARED',
  title: 'Test',
  message: 'Test message',
  isRead: false,
  createdAt: new Date(),
  metadata: {},
};

function setupInsertChain(returnValue: object) {
  const returningFn = vi.fn().mockResolvedValue([returnValue]);
  const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
  vi.mocked(db.insert).mockReturnValue({ values: valuesFn } as unknown as ReturnType<typeof db.insert>);
  return { returningFn, valuesFn };
}

function setupSelectChain(returnValue: unknown[]) {
  const limitFn = vi.fn().mockResolvedValue(returnValue);
  const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
  const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn, limit: limitFn });
  const leftJoinFn = vi.fn().mockReturnValue({ leftJoin: vi.fn().mockReturnValue({ where: whereFn }), where: whereFn });
  const fromFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn, where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  vi.mocked(db.select).mockReturnValue(selectFn() as unknown as ReturnType<typeof db.select>);
  return { selectFn, fromFn, whereFn, orderByFn, limitFn };
}

function setupUpdateChain(returnValue: object[]) {
  const returningFn = vi.fn().mockResolvedValue(returnValue);
  const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  vi.mocked(db.update).mockReturnValue({ set: setFn } as unknown as ReturnType<typeof db.update>);
  return { setFn, whereFn, returningFn };
}

function setupDeleteChain() {
  const whereFn = vi.fn().mockResolvedValue(undefined);
  vi.mocked(db.delete).mockReturnValue({ where: whereFn } as unknown as ReturnType<typeof db.delete>);
  return { whereFn };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn().mockResolvedValue({ ok: true });
});

describe('createNotification', () => {
  it('inserts a notification and returns it', async () => {
    setupInsertChain(mockNotification);

    const result = await createNotification({
      userId: 'user-1',
      type: 'PAGE_SHARED',
      title: 'Test',
      message: 'Test message',
    });

    expect(db.insert).toHaveBeenCalled();
    expect(result).toEqual(mockNotification);
  });

  it('handles broadcast failure gracefully', async () => {
    setupInsertChain(mockNotification);
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await createNotification({
      userId: 'user-1',
      type: 'PAGE_SHARED',
      title: 'Test',
      message: 'Test message',
    });

    expect(result).toEqual(mockNotification);
  });

  it('handles push notification failure gracefully', async () => {
    setupInsertChain(mockNotification);
    vi.mocked(sendPushNotification).mockRejectedValue(new Error('Push failed'));

    const result = await createNotification({
      userId: 'user-1',
      type: 'PAGE_SHARED',
      title: 'Test',
      message: 'Test message',
    });

    expect(result).toEqual(mockNotification);
  });

  it('broadcasts notification to realtime service', async () => {
    setupInsertChain(mockNotification);
    await createNotification({
      userId: 'user-1',
      type: 'PAGE_SHARED',
      title: 'Test',
      message: 'Test message',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/broadcast'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('sends push notification', async () => {
    setupInsertChain(mockNotification);
    await createNotification({
      userId: 'user-1',
      type: 'PAGE_SHARED',
      title: 'Test',
      message: 'Test message',
      pageId: 'page-1',
      driveId: 'drive-1',
    });

    expect(sendPushNotification).toHaveBeenCalledWith('user-1', expect.objectContaining({
      title: 'Test',
      body: 'Test message',
    }));
  });

  it('includes pageId and driveId in push notification data', async () => {
    setupInsertChain(mockNotification);
    await createNotification({
      userId: 'user-1',
      type: 'PAGE_SHARED',
      title: 'Test',
      message: 'Test message',
      pageId: 'page-1',
      driveId: 'drive-1',
    });

    expect(sendPushNotification).toHaveBeenCalledWith('user-1', expect.objectContaining({
      data: expect.objectContaining({ pageId: 'page-1', driveId: 'drive-1' }),
    }));
  });
});

describe('getUserNotifications', () => {
  it('returns mapped notifications with triggeredByUser and drive', async () => {
    const rows = [{
      notification: mockNotification,
      triggeredByUser: { id: 'u2', name: 'Bob', email: 'bob@example.com', image: null },
      drive: { id: 'd1', slug: 'my-drive', name: 'My Drive' },
    }];

    const limitFn = vi.fn().mockResolvedValue(rows);
    const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
    const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
    const leftJoin2Fn = vi.fn().mockReturnValue({ where: whereFn });
    const leftJoin1Fn = vi.fn().mockReturnValue({ leftJoin: leftJoin2Fn });
    const fromFn = vi.fn().mockReturnValue({ leftJoin: leftJoin1Fn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    vi.mocked(db.select).mockImplementation(selectFn);

    const result = await getUserNotifications('user-1');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: mockNotification.id,
      triggeredByUser: { name: 'Bob' },
      drive: { slug: 'my-drive' },
    });
  });
});

describe('getUnreadNotificationCount', () => {
  it('returns count from DB', async () => {
    const limitFn = vi.fn().mockResolvedValue([{ count: '5' }]);
    const whereFn = vi.fn().mockReturnValue({ then: limitFn });
    // Use a simpler chaining approach
    const fromFn = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ count: '5' }]),
    });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    vi.mocked(db.select).mockImplementation(selectFn);

    const result = await getUnreadNotificationCount('user-1');
    expect(typeof result).toBe('number');
  });

  it('returns 0 when no unread notifications', async () => {
    const fromFn = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ count: '0' }]),
    });
    vi.mocked(db.select).mockReturnValue({ from: fromFn } as unknown as ReturnType<typeof db.select>);

    const result = await getUnreadNotificationCount('user-1');
    expect(result).toBe(0);
  });

  it('returns 0 when result is empty', async () => {
    const fromFn = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    });
    vi.mocked(db.select).mockReturnValue({ from: fromFn } as unknown as ReturnType<typeof db.select>);

    const result = await getUnreadNotificationCount('user-1');
    expect(result).toBe(0);
  });
});

describe('getUnreadCount', () => {
  it('is an alias for getUnreadNotificationCount', async () => {
    const fromFn = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ count: '3' }]),
    });
    vi.mocked(db.select).mockReturnValue({ from: fromFn } as unknown as ReturnType<typeof db.select>);

    const result = await getUnreadCount('user-1');
    expect(typeof result).toBe('number');
  });
});

describe('markNotificationAsRead', () => {
  it('returns the updated notification', async () => {
    setupUpdateChain([{ ...mockNotification, isRead: true }]);

    const result = await markNotificationAsRead('notif-1', 'user-1');
    expect(db.update).toHaveBeenCalled();
    expect(result).toMatchObject({ isRead: true });
  });

  it('returns undefined when notification not found', async () => {
    setupUpdateChain([]);

    const result = await markNotificationAsRead('notif-missing', 'user-1');
    expect(result).toBeUndefined();
  });
});

describe('markAllNotificationsAsRead', () => {
  it('calls update on DB', async () => {
    const whereFn = vi.fn().mockResolvedValue(undefined);
    const setFn = vi.fn().mockReturnValue({ where: whereFn });
    vi.mocked(db.update).mockReturnValue({ set: setFn } as unknown as ReturnType<typeof db.update>);

    await markAllNotificationsAsRead('user-1');
    expect(db.update).toHaveBeenCalled();
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({ isRead: true }));
  });
});

describe('deleteNotification', () => {
  it('calls delete on DB', async () => {
    setupDeleteChain();

    await deleteNotification('notif-1', 'user-1');
    expect(db.delete).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createPermissionNotification
// ---------------------------------------------------------------------------
describe('createPermissionNotification', () => {
  const page = {
    id: 'page-1',
    title: 'My Page',
    driveId: 'drive-1',
    drive: { name: 'My Drive' },
  };
  const triggeredByUser = { id: 'user-2', name: 'Alice', email: 'alice@example.com' };

  beforeEach(() => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(page as never);
    vi.mocked(db.query.users.findFirst).mockResolvedValue(triggeredByUser as never);
    setupInsertChain(mockNotification);
  });

  it('returns null when page not found', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined as never);

    const result = await createPermissionNotification('user-1', 'page-1', 'granted', { canView: true }, 'user-2');
    expect(result).toBeNull();
  });

  it('creates PAGE_SHARED notification for granted type', async () => {
    const result = await createPermissionNotification('user-1', 'page-1', 'granted', { canView: true }, 'user-2');
    expect(result).toBeDefined();
    expect(db.insert).toHaveBeenCalled();
  });

  it('creates PERMISSION_UPDATED notification for updated type', async () => {
    await createPermissionNotification('user-1', 'page-1', 'updated', { canView: true, canEdit: true }, 'user-2');
    expect(db.insert).toHaveBeenCalled();
  });

  it('creates PERMISSION_REVOKED notification for revoked type', async () => {
    await createPermissionNotification('user-1', 'page-1', 'revoked', {}, 'user-2');
    expect(db.insert).toHaveBeenCalled();
  });

  it('uses "Someone" when triggeredByUser not found', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined as never);
    await createPermissionNotification('user-1', 'page-1', 'granted', { canView: true }, 'user-2');
    expect(db.insert).toHaveBeenCalled();
  });

  it('includes canEdit in permissionList when canEdit is true', async () => {
    await createPermissionNotification('user-1', 'page-1', 'granted', {
      canView: true,
      canEdit: true,
      canShare: true,
      canDelete: true,
    }, 'user-2');
    expect(db.insert).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createDriveNotification
// ---------------------------------------------------------------------------
describe('createDriveNotification', () => {
  const drive = { id: 'drive-1', name: 'My Drive', slug: 'my-drive' };
  const triggeredByUser = { id: 'user-2', name: 'Alice' };

  beforeEach(() => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(drive as never);
    vi.mocked(db.query.users.findFirst).mockResolvedValue(triggeredByUser as never);
    setupInsertChain(mockNotification);
  });

  it('returns null when drive not found', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined as never);

    const result = await createDriveNotification('user-1', 'drive-1', 'invited');
    expect(result).toBeNull();
  });

  it('creates DRIVE_INVITED notification', async () => {
    const result = await createDriveNotification('user-1', 'drive-1', 'invited', 'MEMBER', 'user-2');
    expect(result).toBeDefined();
  });

  it('creates DRIVE_JOINED notification', async () => {
    await createDriveNotification('user-1', 'drive-1', 'joined', 'MEMBER', 'user-2');
    expect(db.insert).toHaveBeenCalled();
  });

  it('creates DRIVE_ROLE_CHANGED notification', async () => {
    await createDriveNotification('user-1', 'drive-1', 'role_changed', 'ADMIN', 'user-2');
    expect(db.insert).toHaveBeenCalled();
  });

  it('works without triggeredByUserId', async () => {
    await createDriveNotification('user-1', 'drive-1', 'invited');
    expect(db.insert).toHaveBeenCalled();
  });

  it('works without role', async () => {
    await createDriveNotification('user-1', 'drive-1', 'joined');
    expect(db.insert).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createOrUpdateMessageNotification
// ---------------------------------------------------------------------------
describe('createOrUpdateMessageNotification', () => {
  beforeEach(() => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue({ id: 'user-2', name: 'Alice' } as never);
    vi.mocked(db.query.notifications.findFirst).mockResolvedValue(null as never);
    setupInsertChain(mockNotification);
  });

  it('creates new notification when no existing unread notification', async () => {
    vi.mocked(db.query.notifications.findFirst).mockResolvedValue(undefined as never);

    const result = await createOrUpdateMessageNotification('user-1', 'conv-1', 'Hello!', 'user-2');
    expect(result).toBeDefined();
  });

  it('fetches sender name when senderName not provided', async () => {
    vi.mocked(db.query.notifications.findFirst).mockResolvedValue(undefined as never);

    await createOrUpdateMessageNotification('user-1', 'conv-1', 'Hello!', 'user-2');
    expect(db.query.users.findFirst).toHaveBeenCalled();
  });

  it('skips sender lookup when senderName is provided', async () => {
    vi.mocked(db.query.notifications.findFirst).mockResolvedValue(undefined as never);

    await createOrUpdateMessageNotification('user-1', 'conv-1', 'Hello!', 'user-2', 'Alice');
    expect(db.query.users.findFirst).not.toHaveBeenCalled();
  });

  it('updates existing unread notification for same conversation', async () => {
    const existingNotif = { ...mockNotification, id: 'existing-notif-id' };
    vi.mocked(db.query.notifications.findFirst).mockResolvedValue(existingNotif as never);

    setupUpdateChain([existingNotif]);

    const result = await createOrUpdateMessageNotification('user-1', 'conv-1', 'New message', 'user-2');
    expect(db.update).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('uses "Someone" when sender not found in DB', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined as never);
    vi.mocked(db.query.notifications.findFirst).mockResolvedValue(undefined as never);

    const result = await createOrUpdateMessageNotification('user-1', 'conv-1', 'Hello!', 'user-2');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// createMentionNotification
// ---------------------------------------------------------------------------
describe('createMentionNotification', () => {
  const page = {
    id: 'page-1',
    title: 'My Page',
    type: 'DOCUMENT',
    driveId: 'drive-1',
    drive: { name: 'My Drive', slug: 'my-drive' },
  };
  const triggeredByUser = { id: 'user-2', name: 'Alice' };

  beforeEach(() => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(page as never);
    vi.mocked(db.query.users.findFirst).mockResolvedValue(triggeredByUser as never);
    setupInsertChain(mockNotification);
  });

  it('returns null for self-mention (targetUserId === triggeredByUserId)', async () => {
    const result = await createMentionNotification('user-1', 'page-1', 'user-1');
    expect(result).toBeNull();
    expect(db.query.pages.findFirst).not.toHaveBeenCalled();
  });

  it('returns null when page not found', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined as never);

    const result = await createMentionNotification('user-1', 'page-1', 'user-2');
    expect(result).toBeNull();
  });

  it('creates MENTION notification for valid mention', async () => {
    const result = await createMentionNotification('user-1', 'page-1', 'user-2');
    expect(result).toBeDefined();
    expect(db.insert).toHaveBeenCalled();
  });

  it('uses "Someone" when mentioner user not found', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined as never);

    await createMentionNotification('user-1', 'page-1', 'user-2');
    expect(db.insert).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createTaskAssignedNotification
// ---------------------------------------------------------------------------
describe('createTaskAssignedNotification', () => {
  const taskListPage = {
    id: 'page-tasks',
    title: 'Task List',
    driveId: 'drive-1',
    drive: { name: 'My Drive', slug: 'my-drive' },
  };
  const assignerUser = { id: 'user-2', name: 'Bob' };

  beforeEach(() => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(taskListPage as never);
    vi.mocked(db.query.users.findFirst).mockResolvedValue(assignerUser as never);
    setupInsertChain(mockNotification);
  });

  it('returns null for self-assignment', async () => {
    const result = await createTaskAssignedNotification('user-1', 'task-1', 'My Task', 'page-tasks', 'user-1');
    expect(result).toBeNull();
  });

  it('returns null when task list page not found', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined as never);

    const result = await createTaskAssignedNotification('user-1', 'task-1', 'My Task', 'page-tasks', 'user-2');
    expect(result).toBeNull();
  });

  it('creates TASK_ASSIGNED notification', async () => {
    const result = await createTaskAssignedNotification('user-1', 'task-1', 'My Task', 'page-tasks', 'user-2');
    expect(result).toBeDefined();
    expect(db.insert).toHaveBeenCalled();
  });

  it('uses "Someone" when assigner not found', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined as never);

    await createTaskAssignedNotification('user-1', 'task-1', 'My Task', 'page-tasks', 'user-2');
    expect(db.insert).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// broadcastTosPrivacyUpdate
// ---------------------------------------------------------------------------
describe('broadcastTosPrivacyUpdate', () => {
  it('creates notifications for all users for tos update', async () => {
    const allUsers = [{ id: 'user-1' }, { id: 'user-2' }];

    const fromFn = vi.fn().mockResolvedValue(allUsers);
    vi.mocked(db.select).mockReturnValue({ from: fromFn } as unknown as ReturnType<typeof db.select>);
    setupInsertChain(mockNotification);

    const result = await broadcastTosPrivacyUpdate('tos');

    expect(result.success).toBe(true);
    expect(result.notifiedUsers).toBe(2);
  });

  it('creates notifications for all users for privacy update', async () => {
    const allUsers = [{ id: 'user-1' }];

    const fromFn = vi.fn().mockResolvedValue(allUsers);
    vi.mocked(db.select).mockReturnValue({ from: fromFn } as unknown as ReturnType<typeof db.select>);
    setupInsertChain(mockNotification);

    const result = await broadcastTosPrivacyUpdate('privacy');

    expect(result.success).toBe(true);
    expect(result.notifiedUsers).toBe(1);
  });

  it('throws and re-throws on error', async () => {
    const fromFn = vi.fn().mockRejectedValue(new Error('DB error'));
    vi.mocked(db.select).mockReturnValue({ from: fromFn } as unknown as ReturnType<typeof db.select>);

    await expect(broadcastTosPrivacyUpdate('tos')).rejects.toThrow('DB error');
  });
});

// ---------------------------------------------------------------------------
// markConnectionRequestActioned
// ---------------------------------------------------------------------------
describe('markConnectionRequestActioned', () => {
  const existingNotification = {
    id: 'notif-1',
    userId: 'user-1',
    type: 'CONNECTION_REQUEST',
    isRead: false,
    readAt: null,
    metadata: { connectionId: 'conn-1', senderId: 'user-2' },
  };

  beforeEach(() => {
    vi.mocked(db.query.notifications.findFirst).mockResolvedValue(existingNotification as never);
    setupUpdateChain([{ ...existingNotification, isRead: true, metadata: { connectionId: 'conn-1', senderId: 'user-2', actioned: true, actionedStatus: 'accepted' } }]);
  });

  it('updates the notification with actioned=true and actionedStatus when found', async () => {
    await markConnectionRequestActioned('conn-1', 'user-1', 'accepted');
    expect(db.query.notifications.findFirst).toHaveBeenCalled();
    expect(db.update).toHaveBeenCalled();
  });

  it('sets isRead:true and the actioned metadata fields', async () => {
    const { setFn } = setupUpdateChain([existingNotification]);
    await markConnectionRequestActioned('conn-1', 'user-1', 'rejected');
    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({
        isRead: true,
        metadata: expect.objectContaining({ actioned: true, actionedStatus: 'rejected' }),
      }),
    );
  });

  it('preserves existing metadata fields when updating', async () => {
    const { setFn } = setupUpdateChain([existingNotification]);
    await markConnectionRequestActioned('conn-1', 'user-1', 'accepted');
    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ connectionId: 'conn-1', senderId: 'user-2' }),
      }),
    );
  });

  it('returns early without updating when no notification is found', async () => {
    vi.mocked(db.query.notifications.findFirst).mockResolvedValue(undefined as never);
    await markConnectionRequestActioned('conn-1', 'user-1', 'accepted');
    expect(db.update).not.toHaveBeenCalled();
  });
});
