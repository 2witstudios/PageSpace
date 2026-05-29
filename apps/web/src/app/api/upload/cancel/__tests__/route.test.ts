import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => r !== null && typeof r === 'object' && 'error' in r),
}));

vi.mock('@pagespace/lib/services/upload-semaphore', () => ({
  uploadSemaphore: { verifySlotOwner: vi.fn(), releaseUploadSlot: vi.fn() },
}));

vi.mock('@pagespace/lib/services/storage-limits', () => ({
  updateActiveUploads: vi.fn(),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { uploadSemaphore } from '@pagespace/lib/services/upload-semaphore';
import { updateActiveUploads } from '@pagespace/lib/services/storage-limits';

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
  vi.mocked(updateActiveUploads).mockResolvedValue(undefined);
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

  it('releases the slot and decrements activeUploads for a slot the user owns', async () => {
    const res = await POST(makeRequest({ jobId: JOB_ID }));
    expect(res.status).toBe(200);
    expect(uploadSemaphore.releaseUploadSlot).toHaveBeenCalledWith(JOB_ID);
    expect(updateActiveUploads).toHaveBeenCalledWith('user-1', -1);
  });

  it('does not release a slot the user does not own', async () => {
    vi.mocked(uploadSemaphore.verifySlotOwner).mockReturnValue(false);
    const res = await POST(makeRequest({ jobId: JOB_ID }));
    expect(res.status).toBe(403);
    expect(uploadSemaphore.releaseUploadSlot).not.toHaveBeenCalled();
  });
});
