import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => r !== null && typeof r === 'object' && 'error' in r),
  checkMCPCreateScope: vi.fn(() => null),
}));

vi.mock('@pagespace/lib/services/upload-semaphore', () => ({
  uploadSemaphore: { verifySlotOwner: vi.fn(), getSlotMetadata: vi.fn(), releaseUploadSlot: vi.fn() },
}));

vi.mock('@pagespace/lib/services/pending-uploads', () => ({
  releasePendingUpload: vi.fn(),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { uploadSemaphore } from '@pagespace/lib/services/upload-semaphore';
import { releasePendingUpload } from '@pagespace/lib/services/pending-uploads';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const JOB_ID = 'user-1-slot-abc';

function makeAuth(userId = 'user-1') {
  return { userId, tokenType: 'session' as const, tokenVersion: 0, sessionId: 's', role: 'user' as const, adminRoleVersion: 0 };
}

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/upload/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(makeAuth());
  vi.mocked(uploadSemaphore.verifySlotOwner).mockReturnValue(true);
  vi.mocked(uploadSemaphore.getSlotMetadata).mockReturnValue({ contentHash: 'a'.repeat(64), driveId: 'drive-1', fileSize: 1024, mimeType: 'image/jpeg' });
  vi.mocked(releasePendingUpload).mockResolvedValue(undefined);
});

describe('POST /api/upload/cancel', () => {
  it('returns 401 when not authenticated', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ error: new Response(null, { status: 401 }) } as never);
    const res = await POST(makeRequest({ jobId: JOB_ID }));
    expect(res.status).toBe(401);
  });

  it('returns 400 when jobId is missing', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it('releases the slot and the pending-upload reservation for a slot the user owns', async () => {
    const res = await POST(makeRequest({ jobId: JOB_ID }));
    expect(res.status).toBe(200);
    expect(uploadSemaphore.releaseUploadSlot).toHaveBeenCalledWith(JOB_ID);
    expect(releasePendingUpload).toHaveBeenCalledWith(JOB_ID);
    expect(auditRequest).toHaveBeenCalled();
  });

  it('does not release a slot the user does not own', async () => {
    vi.mocked(uploadSemaphore.verifySlotOwner).mockReturnValue(false);
    const res = await POST(makeRequest({ jobId: JOB_ID }));
    expect(res.status).toBe(403);
    expect(uploadSemaphore.releaseUploadSlot).not.toHaveBeenCalled();
  });
});
