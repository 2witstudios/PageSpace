/**
 * Security audit tests for /api/files/[id]/convert-to-document
 * Verifies securityAudit.logDataAccess is called for POST (write, convert).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: { pages: { findFirst: vi.fn() } },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'new-page-1', title: 'Converted', type: 'DOCUMENT' }]),
      }),
    }),
  },
  pages: { id: 'id' },
  eq: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  PageType: { DOCUMENT: 'DOCUMENT', FILE: 'FILE' },
  canConvertToType: vi.fn().mockReturnValue(true),
  canUserEditPage: vi.fn().mockResolvedValue(true),
  canUserViewPage: vi.fn().mockResolvedValue(true),
  createPageServiceToken: vi.fn().mockResolvedValue({ token: 'mock-token' }),
}));

vi.mock('mammoth', () => ({
  default: { convertToHtml: vi.fn().mockResolvedValue({ value: '<p>Converted</p>', messages: [] }) },
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('new-page-1'),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn().mockResolvedValue(undefined),
  createPageEventPayload: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@example.com' }),
  logFileActivity: vi.fn(),
  logPageActivity: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  securityAudit: {
    logDataAccess: vi.fn().mockResolvedValue(undefined),
  },
}));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { securityAudit } from '@pagespace/lib/server';
import { db } from '@pagespace/db';

const mockUserId = 'user_123';
const mockFileId = 'file-1';

const mockAuth = () => {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
    userId: mockUserId,
    tokenVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'test-session',
    role: 'user' as const,
    adminRoleVersion: 0,
  });
};

describe('POST /api/files/[id]/convert-to-document audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({
      id: mockFileId,
      title: 'test.docx',
      type: 'FILE',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filePath: 'hash-123',
      position: 0,
      driveId: 'drive-1',
      parentId: null,
      originalFileName: 'test.docx',
      drive: { id: 'drive-1', name: 'Test Drive' },
    });
    // Mock fetch for processor
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
    });
  });

  it('logs write audit event with convert action', async () => {
    const request = new Request('http://localhost/api/files/file-1/convert-to-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Converted Document' }),
    });

    await POST(request, { params: Promise.resolve({ id: mockFileId }) });

    expect(securityAudit.logDataAccess).toHaveBeenCalledWith(
      mockUserId, 'write', 'file', mockFileId, { action: 'convert' }
    );
  });
});
