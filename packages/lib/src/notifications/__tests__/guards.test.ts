import { describe, it, expect } from 'vitest';
import {
  isConnectionRequest,
  isConnectionAccepted,
  isConnectionRejected,
  isNewDirectMessage,
  isPermissionGranted,
  isPermissionUpdated,
  isPermissionRevoked,
  isPageShared,
  isDriveInvited,
  isDriveJoined,
  isDriveRoleChanged,
  hasMetadataField,
} from '../guards';
import type { LegacyNotification } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base(overrides: Partial<LegacyNotification> = {}): LegacyNotification {
  return {
    id: 'notif-1',
    userId: 'user-1',
    isRead: false,
    createdAt: new Date(),
    type: 'UNKNOWN',
    title: 'Title',
    message: 'Message',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isConnectionRequest
// ---------------------------------------------------------------------------
describe('isConnectionRequest', () => {
  it('returns true for matching type with connectionId in metadata', () => {
    const n = base({ type: 'CONNECTION_REQUEST', metadata: { connectionId: 'c1' } });
    expect(isConnectionRequest(n)).toBe(true);
  });

  it('returns false for wrong type even with connectionId', () => {
    const n = base({ type: 'DRIVE_INVITED', metadata: { connectionId: 'c1' } });
    expect(isConnectionRequest(n)).toBe(false);
  });

  it('returns false when metadata is undefined', () => {
    const n = base({ type: 'CONNECTION_REQUEST', metadata: undefined });
    expect(isConnectionRequest(n)).toBe(false);
  });

  it('returns false when metadata is missing connectionId key', () => {
    const n = base({ type: 'CONNECTION_REQUEST', metadata: { otherId: 'x' } });
    expect(isConnectionRequest(n)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isConnectionAccepted
// ---------------------------------------------------------------------------
describe('isConnectionAccepted', () => {
  it('returns true for matching type with connectionId', () => {
    const n = base({ type: 'CONNECTION_ACCEPTED', metadata: { connectionId: 'c2' } });
    expect(isConnectionAccepted(n)).toBe(true);
  });

  it('returns false for wrong type', () => {
    const n = base({ type: 'CONNECTION_REQUEST', metadata: { connectionId: 'c2' } });
    expect(isConnectionAccepted(n)).toBe(false);
  });

  it('returns false when metadata is undefined', () => {
    const n = base({ type: 'CONNECTION_ACCEPTED', metadata: undefined });
    expect(isConnectionAccepted(n)).toBe(false);
  });

  it('returns false when metadata is missing connectionId', () => {
    const n = base({ type: 'CONNECTION_ACCEPTED', metadata: { foo: 'bar' } });
    expect(isConnectionAccepted(n)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isConnectionRejected
// ---------------------------------------------------------------------------
describe('isConnectionRejected', () => {
  it('returns true for matching type with connectionId', () => {
    const n = base({ type: 'CONNECTION_REJECTED', metadata: { connectionId: 'c3' } });
    expect(isConnectionRejected(n)).toBe(true);
  });

  it('returns false for wrong type', () => {
    const n = base({ type: 'CONNECTION_ACCEPTED', metadata: { connectionId: 'c3' } });
    expect(isConnectionRejected(n)).toBe(false);
  });

  it('returns false when metadata is undefined', () => {
    const n = base({ type: 'CONNECTION_REJECTED', metadata: undefined });
    expect(isConnectionRejected(n)).toBe(false);
  });

  it('returns false when metadata is missing connectionId', () => {
    const n = base({ type: 'CONNECTION_REJECTED', metadata: {} });
    expect(isConnectionRejected(n)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isNewDirectMessage
// ---------------------------------------------------------------------------
describe('isNewDirectMessage', () => {
  it('returns true for matching type with conversationId', () => {
    const n = base({ type: 'NEW_DIRECT_MESSAGE', metadata: { conversationId: 'conv-1' } });
    expect(isNewDirectMessage(n)).toBe(true);
  });

  it('returns false for wrong type', () => {
    const n = base({ type: 'PAGE_SHARED', metadata: { conversationId: 'conv-1' } });
    expect(isNewDirectMessage(n)).toBe(false);
  });

  it('returns false when metadata is undefined', () => {
    const n = base({ type: 'NEW_DIRECT_MESSAGE', metadata: undefined });
    expect(isNewDirectMessage(n)).toBe(false);
  });

  it('returns false when metadata is missing conversationId', () => {
    const n = base({ type: 'NEW_DIRECT_MESSAGE', metadata: { otherId: 'x' } });
    expect(isNewDirectMessage(n)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPermissionGranted
// ---------------------------------------------------------------------------
describe('isPermissionGranted', () => {
  it('returns true for matching type with permissions key', () => {
    const n = base({ type: 'PERMISSION_GRANTED', metadata: { permissions: { canView: true } } });
    expect(isPermissionGranted(n)).toBe(true);
  });

  it('returns false for wrong type', () => {
    const n = base({ type: 'PERMISSION_REVOKED', metadata: { permissions: {} } });
    expect(isPermissionGranted(n)).toBe(false);
  });

  it('returns false when metadata is undefined', () => {
    const n = base({ type: 'PERMISSION_GRANTED', metadata: undefined });
    expect(isPermissionGranted(n)).toBe(false);
  });

  it('returns false when metadata is missing permissions key', () => {
    const n = base({ type: 'PERMISSION_GRANTED', metadata: { pageName: 'My Page' } });
    expect(isPermissionGranted(n)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPermissionUpdated
// ---------------------------------------------------------------------------
describe('isPermissionUpdated', () => {
  it('returns true for matching type with permissions key', () => {
    const n = base({ type: 'PERMISSION_UPDATED', metadata: { permissions: { canEdit: true } } });
    expect(isPermissionUpdated(n)).toBe(true);
  });

  it('returns false for wrong type', () => {
    const n = base({ type: 'PERMISSION_GRANTED', metadata: { permissions: {} } });
    expect(isPermissionUpdated(n)).toBe(false);
  });

  it('returns false when metadata is undefined', () => {
    const n = base({ type: 'PERMISSION_UPDATED', metadata: undefined });
    expect(isPermissionUpdated(n)).toBe(false);
  });

  it('returns false when metadata is missing permissions key', () => {
    const n = base({ type: 'PERMISSION_UPDATED', metadata: { pageName: 'My Page' } });
    expect(isPermissionUpdated(n)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPermissionRevoked
// ---------------------------------------------------------------------------
describe('isPermissionRevoked', () => {
  it('returns true for matching type with permissions key', () => {
    const n = base({ type: 'PERMISSION_REVOKED', metadata: { permissions: {} } });
    expect(isPermissionRevoked(n)).toBe(true);
  });

  it('returns false for wrong type', () => {
    const n = base({ type: 'PAGE_SHARED', metadata: { permissions: {} } });
    expect(isPermissionRevoked(n)).toBe(false);
  });

  it('returns false when metadata is undefined', () => {
    const n = base({ type: 'PERMISSION_REVOKED', metadata: undefined });
    expect(isPermissionRevoked(n)).toBe(false);
  });

  it('returns false when metadata is missing permissions key', () => {
    const n = base({ type: 'PERMISSION_REVOKED', metadata: { pageName: 'My Page' } });
    expect(isPermissionRevoked(n)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPageShared
// ---------------------------------------------------------------------------
describe('isPageShared', () => {
  it('returns true for matching type with permissions key', () => {
    const n = base({ type: 'PAGE_SHARED', metadata: { permissions: { canView: true } } });
    expect(isPageShared(n)).toBe(true);
  });

  it('returns false for wrong type', () => {
    const n = base({ type: 'PERMISSION_GRANTED', metadata: { permissions: {} } });
    expect(isPageShared(n)).toBe(false);
  });

  it('returns false when metadata is undefined', () => {
    const n = base({ type: 'PAGE_SHARED', metadata: undefined });
    expect(isPageShared(n)).toBe(false);
  });

  it('returns false when metadata is missing permissions key', () => {
    const n = base({ type: 'PAGE_SHARED', metadata: { pageName: 'My Page' } });
    expect(isPageShared(n)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDriveInvited
// ---------------------------------------------------------------------------
describe('isDriveInvited', () => {
  it('returns true for matching type with driveName key', () => {
    const n = base({ type: 'DRIVE_INVITED', metadata: { driveName: 'My Drive' } });
    expect(isDriveInvited(n)).toBe(true);
  });

  it('returns false for wrong type', () => {
    const n = base({ type: 'DRIVE_JOINED', metadata: { driveName: 'My Drive' } });
    expect(isDriveInvited(n)).toBe(false);
  });

  it('returns false when metadata is undefined', () => {
    const n = base({ type: 'DRIVE_INVITED', metadata: undefined });
    expect(isDriveInvited(n)).toBe(false);
  });

  it('returns false when metadata is missing driveName key', () => {
    const n = base({ type: 'DRIVE_INVITED', metadata: { role: 'MEMBER' } });
    expect(isDriveInvited(n)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDriveJoined
// ---------------------------------------------------------------------------
describe('isDriveJoined', () => {
  it('returns true for matching type with driveName key', () => {
    const n = base({ type: 'DRIVE_JOINED', metadata: { driveName: 'My Drive' } });
    expect(isDriveJoined(n)).toBe(true);
  });

  it('returns false for wrong type', () => {
    const n = base({ type: 'DRIVE_INVITED', metadata: { driveName: 'My Drive' } });
    expect(isDriveJoined(n)).toBe(false);
  });

  it('returns false when metadata is undefined', () => {
    const n = base({ type: 'DRIVE_JOINED', metadata: undefined });
    expect(isDriveJoined(n)).toBe(false);
  });

  it('returns false when metadata is missing driveName key', () => {
    const n = base({ type: 'DRIVE_JOINED', metadata: { role: 'MEMBER' } });
    expect(isDriveJoined(n)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDriveRoleChanged
// ---------------------------------------------------------------------------
describe('isDriveRoleChanged', () => {
  it('returns true for matching type with driveName key', () => {
    const n = base({ type: 'DRIVE_ROLE_CHANGED', metadata: { driveName: 'My Drive' } });
    expect(isDriveRoleChanged(n)).toBe(true);
  });

  it('returns false for wrong type', () => {
    const n = base({ type: 'DRIVE_JOINED', metadata: { driveName: 'My Drive' } });
    expect(isDriveRoleChanged(n)).toBe(false);
  });

  it('returns false when metadata is undefined', () => {
    const n = base({ type: 'DRIVE_ROLE_CHANGED', metadata: undefined });
    expect(isDriveRoleChanged(n)).toBe(false);
  });

  it('returns false when metadata is missing driveName key', () => {
    const n = base({ type: 'DRIVE_ROLE_CHANGED', metadata: { previousRole: 'MEMBER' } });
    expect(isDriveRoleChanged(n)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasMetadataField
// ---------------------------------------------------------------------------
describe('hasMetadataField', () => {
  it('returns true when the specified field is present in metadata', () => {
    const n = base({ metadata: { connectionId: 'c1', extra: 'value' } });
    expect(hasMetadataField(n, 'connectionId')).toBe(true);
  });

  it('returns true for a second field when both are present', () => {
    const n = base({ metadata: { connectionId: 'c1', extra: 'value' } });
    expect(hasMetadataField(n, 'extra')).toBe(true);
  });

  it('returns false when the field is not present in metadata', () => {
    const n = base({ metadata: { connectionId: 'c1' } });
    expect(hasMetadataField(n, 'driveName')).toBe(false);
  });

  it('returns false when metadata is undefined', () => {
    const n = base({ metadata: undefined });
    expect(hasMetadataField(n, 'connectionId')).toBe(false);
  });

  it('returns false when metadata is an empty object', () => {
    const n = base({ metadata: {} });
    expect(hasMetadataField(n, 'connectionId')).toBe(false);
  });
});
