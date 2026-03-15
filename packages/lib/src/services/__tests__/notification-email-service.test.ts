import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db', () => {
  const eq = vi.fn((a, b) => ({ op: 'eq', a, b }));
  const and = vi.fn((...args: unknown[]) => ({ op: 'and', args }));

  return {
    db: {
      query: {
        users: { findFirst: vi.fn() },
        emailNotificationPreferences: { findFirst: vi.fn() },
      },
      insert: vi.fn(() => ({
        values: vi.fn().mockResolvedValue(undefined),
      })),
    },
    users: { id: 'users.id', email: 'users.email', name: 'users.name' },
    emailNotificationPreferences: { userId: 'enp.userId', notificationType: 'enp.notificationType', emailEnabled: 'enp.emailEnabled' },
    emailNotificationLog: { userId: 'enl.userId' },
    emailUnsubscribeTokens: { tokenHash: 'eut.tokenHash' },
    eq, and,
  };
});

vi.mock('../email-service', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

// Mock all email templates
vi.mock('../../email-templates/DriveInvitationEmail', () => ({ DriveInvitationEmail: vi.fn(() => 'DriveInvitationEmail') }));
vi.mock('../../email-templates/DirectMessageEmail', () => ({ DirectMessageEmail: vi.fn(() => 'DirectMessageEmail') }));
vi.mock('../../email-templates/ConnectionRequestEmail', () => ({ ConnectionRequestEmail: vi.fn(() => 'ConnectionRequestEmail') }));
vi.mock('../../email-templates/PageSharedEmail', () => ({ PageSharedEmail: vi.fn(() => 'PageSharedEmail') }));
vi.mock('../../email-templates/CollaboratorAddedEmail', () => ({ CollaboratorAddedEmail: vi.fn(() => 'CollaboratorAddedEmail') }));
vi.mock('../../email-templates/ConnectionAcceptedEmail', () => ({ ConnectionAcceptedEmail: vi.fn(() => 'ConnectionAcceptedEmail') }));
vi.mock('../../email-templates/ConnectionRejectedEmail', () => ({ ConnectionRejectedEmail: vi.fn(() => 'ConnectionRejectedEmail') }));
vi.mock('../../email-templates/PermissionRevokedEmail', () => ({ PermissionRevokedEmail: vi.fn(() => 'PermissionRevokedEmail') }));
vi.mock('../../email-templates/PermissionUpdatedEmail', () => ({ PermissionUpdatedEmail: vi.fn(() => 'PermissionUpdatedEmail') }));
vi.mock('../../email-templates/DriveJoinedEmail', () => ({ DriveJoinedEmail: vi.fn(() => 'DriveJoinedEmail') }));
vi.mock('../../email-templates/DriveRoleChangedEmail', () => ({ DriveRoleChangedEmail: vi.fn(() => 'DriveRoleChangedEmail') }));

vi.mock('../../auth/token-utils', () => ({
  hashToken: vi.fn((t: string) => `hashed_${t}`),
  getTokenPrefix: vi.fn((t: string) => t.substring(0, 12)),
}));

import { db } from '@pagespace/db';
import { sendEmail } from '../email-service';
import { sendNotificationEmail } from '../notification-email-service';

type MockFn = ReturnType<typeof vi.fn>;
type MockDb = {
  query: {
    users: { findFirst: MockFn };
    emailNotificationPreferences: { findFirst: MockFn };
  };
  insert: MockFn;
};
const mockDb = db as unknown as MockDb;

describe('notification-email-service @scaffold', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: notifications enabled, user has email
    mockDb.query.emailNotificationPreferences.findFirst.mockResolvedValue(null); // default enabled
    mockDb.query.users.findFirst.mockResolvedValue({ name: 'Test User', email: 'test@example.com' });
    mockDb.insert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
  });

  it('should skip when user has notifications disabled', async () => {
    mockDb.query.emailNotificationPreferences.findFirst.mockResolvedValueOnce({ emailEnabled: false });

    await sendNotificationEmail({
      userId: 'user-1',
      type: 'DRIVE_INVITED',
      metadata: { driveName: 'Test Drive' },
    });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('should skip when user has no email', async () => {
    mockDb.query.users.findFirst.mockResolvedValueOnce(null);

    await sendNotificationEmail({
      userId: 'user-1',
      type: 'DRIVE_INVITED',
      metadata: {},
    });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('should skip for unsupported notification types', async () => {
    await sendNotificationEmail({
      userId: 'user-1',
      type: 'MENTION' as never,
      metadata: {},
    });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('should send DRIVE_INVITED email', async () => {
    await sendNotificationEmail({
      userId: 'user-1',
      type: 'DRIVE_INVITED',
      metadata: { driveName: 'Test Drive', inviterName: 'Alice', driveId: 'd1' },
    });

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'test@example.com',
      subject: expect.stringContaining('Test Drive'),
    }));
  });

  it('should send NEW_DIRECT_MESSAGE email', async () => {
    await sendNotificationEmail({
      userId: 'user-1',
      type: 'NEW_DIRECT_MESSAGE',
      metadata: { senderName: 'Bob', messagePreview: 'Hello', conversationId: 'c1' },
    });

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.stringContaining('Bob'),
    }));
  });

  it('should send CONNECTION_REQUEST email', async () => {
    await sendNotificationEmail({
      userId: 'user-1',
      type: 'CONNECTION_REQUEST',
      metadata: { requesterName: 'Charlie' },
    });

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.stringContaining('Charlie'),
    }));
  });

  it('should send PAGE_SHARED email with page title in subject', async () => {
    await sendNotificationEmail({
      userId: 'user-1',
      type: 'PAGE_SHARED',
      metadata: { sharerName: 'Dave', pageTitle: 'My Page', driveId: 'd1', pageId: 'p1' },
    });

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'test@example.com',
      subject: expect.stringContaining('My Page'),
    }));
  });

  it('should send PERMISSION_GRANTED with edit as CollaboratorAdded', async () => {
    await sendNotificationEmail({
      userId: 'user-1',
      type: 'PERMISSION_GRANTED',
      metadata: {
        permissions: { canEdit: true },
        adderName: 'Eve',
        pageTitle: 'Doc',
        driveId: 'd1',
        pageId: 'p1',
      },
    });

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.stringContaining('edit'),
    }));
  });

  it('should send PERMISSION_GRANTED without edit as PageShared with sharer in subject', async () => {
    await sendNotificationEmail({
      userId: 'user-1',
      type: 'PERMISSION_GRANTED',
      metadata: {
        permissions: { canView: true },
        sharerName: 'Eve',
        pageTitle: 'Doc',
        driveId: 'd1',
        pageId: 'p1',
      },
    });

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'test@example.com',
      subject: expect.stringContaining('Eve'),
    }));
  });

  it('should send CONNECTION_ACCEPTED email with accepter name', async () => {
    await sendNotificationEmail({
      userId: 'user-1',
      type: 'CONNECTION_ACCEPTED',
      metadata: { accepterName: 'Frank' },
    });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'test@example.com',
      subject: expect.stringContaining('Frank'),
    }));
  });

  it('should send CONNECTION_REJECTED email', async () => {
    await sendNotificationEmail({
      userId: 'user-1',
      type: 'CONNECTION_REJECTED',
      metadata: { rejecterName: 'Grace' },
    });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'test@example.com',
      subject: 'Connection request declined',
    }));
  });

  it('should send PERMISSION_REVOKED email with page title', async () => {
    await sendNotificationEmail({
      userId: 'user-1',
      type: 'PERMISSION_REVOKED',
      metadata: { pageTitle: 'Lost Page' },
    });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'test@example.com',
      subject: expect.stringContaining('Lost Page'),
    }));
  });

  it('should send PERMISSION_UPDATED email with page title', async () => {
    await sendNotificationEmail({
      userId: 'user-1',
      type: 'PERMISSION_UPDATED',
      metadata: { pageTitle: 'Updated Page', driveId: 'd1', pageId: 'p1' },
    });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'test@example.com',
      subject: expect.stringContaining('Updated Page'),
    }));
  });

  it('should send DRIVE_JOINED email with drive name', async () => {
    await sendNotificationEmail({
      userId: 'user-1',
      type: 'DRIVE_JOINED',
      metadata: { driveName: 'Workspace', driveId: 'd1' },
    });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'test@example.com',
      subject: expect.stringContaining('Workspace'),
    }));
  });

  it('should send DRIVE_ROLE_CHANGED email with drive name', async () => {
    await sendNotificationEmail({
      userId: 'user-1',
      type: 'DRIVE_ROLE_CHANGED',
      metadata: { driveName: 'Workspace', role: 'admin', driveId: 'd1' },
    });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'test@example.com',
      subject: expect.stringContaining('Workspace'),
    }));
  });

  it('should handle sendEmail errors gracefully without throwing', async () => {
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error('SMTP error'));

    // Contract: sendNotificationEmail never throws, even on SMTP failure
    await expect(sendNotificationEmail({
      userId: 'user-1',
      type: 'DRIVE_INVITED',
      metadata: { driveName: 'Test' },
    })).resolves.toBeUndefined();
  });

  it('should handle preference check errors gracefully', async () => {
    mockDb.query.emailNotificationPreferences.findFirst.mockRejectedValueOnce(new Error('DB error'));

    // Should still send (defaults to enabled on error)
    await sendNotificationEmail({
      userId: 'user-1',
      type: 'DRIVE_INVITED',
      metadata: { driveName: 'Test' },
    });

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'test@example.com' }));
  });
});
