/**
 * Permanent drive delete.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockFindDrive,
  mockDeleteWhere,
  mockAuthenticate,
  mockGetRecipients,
  mockBroadcast,
  mockAuditRequest,
} = vi.hoisted(() => ({
  mockFindDrive: vi.fn(),
  mockDeleteWhere: vi.fn(),
  mockAuthenticate: vi.fn(),
  mockGetRecipients: vi.fn(),
  mockBroadcast: vi.fn(),
  mockAuditRequest: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { drives: { findFirst: (...args: unknown[]) => mockFindDrive(...args) } },
    delete: () => ({ where: (...args: unknown[]) => mockDeleteWhere(...args) }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
}));
vi.mock('@pagespace/db/schema/core', () => ({ drives: {} }));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticate(...args),
  isAuthError: (value: unknown) => typeof value === 'object' && value !== null && 'error' in value,
}));
vi.mock('@pagespace/lib/services/drive-guards', () => ({
  isHomeDrive: vi.fn(() => false),
  homeDriveActionError: vi.fn(() => 'nope'),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: (...args: unknown[]) => mockAuditRequest(...args) }));
vi.mock('@/lib/websocket', () => ({
  broadcastDriveEvent: (...args: unknown[]) => mockBroadcast(...args),
  createDriveEventPayload: vi.fn((...args: unknown[]) => args),
}));
vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: (...args: unknown[]) => mockGetRecipients(...args),
}));
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { status: init?.status ?? 200 }),
  },
}));

import { DELETE } from '../route';

function makeRequest(): Request {
  return new Request('http://localhost:3000/api/trash/drives/drive-1', { method: 'DELETE' });
}

const context = { params: Promise.resolve({ driveId: 'drive-1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticate.mockResolvedValue({ userId: 'user-1' });
  mockFindDrive.mockResolvedValue({ id: 'drive-1', name: 'Work', slug: 'work', isTrashed: true, ownerId: 'user-1' });
  mockGetRecipients.mockResolvedValue(['user-1']);
  mockBroadcast.mockResolvedValue(undefined);
  mockDeleteWhere.mockResolvedValue(undefined);
});

describe('DELETE /api/trash/drives/[driveId]', () => {
  it('given an authenticated owner deleting a trashed drive, should permanently delete it and broadcast', async () => {
    const response = await DELETE(makeRequest(), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.delete', userId: 'user-1', resourceType: 'drive', resourceId: 'drive-1' }),
    );
  });

  it('given the drive is not owned by the requester, should return 404 and never delete', async () => {
    mockFindDrive.mockResolvedValue(undefined);

    const response = await DELETE(makeRequest(), context);

    expect(response.status).toBe(404);
    expect(mockDeleteWhere).not.toHaveBeenCalled();
  });

  it('given the drive is not in the trash, should reject with 400 and never delete', async () => {
    mockFindDrive.mockResolvedValue({ id: 'drive-1', isTrashed: false });

    const response = await DELETE(makeRequest(), context);

    expect(response.status).toBe(400);
    expect(mockDeleteWhere).not.toHaveBeenCalled();
  });
});
