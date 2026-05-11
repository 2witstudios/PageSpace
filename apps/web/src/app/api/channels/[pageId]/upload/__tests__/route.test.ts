/**
 * Channel upload route tests.
 *
 * After PR 3 the route is a thin wrapper that builds a page AttachmentTarget and
 * delegates to processAttachmentUpload. These tests assert the wrapper contract
 * (validation, permission gate, delegation shape) without exercising the full
 * upload pipeline — that is covered by the lib package's process-attachment-upload tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Auth -----------------------------------------------------------------------
vi.mock('@/lib/auth', () => ({
  authenticateWithEnforcedContext: vi.fn(),
  isEnforcedAuthError: vi.fn((r: unknown) => typeof r === 'object' && r !== null && 'error' in r),
}));

// --- Database boundary mocks ----------------------------------------------------
const mockPagesFindFirst = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { pages: { findFirst: (...args: unknown[]) => mockPagesFindFirst(...args) } },
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'pages.id' } }));

// --- Permission gate ------------------------------------------------------------
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserEditPage: vi.fn(),
}));

// --- Audit + logger seams -------------------------------------------------------
const mockAuditRequest = vi.fn();
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

// --- Service seam (the single function the wrapper must delegate to) ------------
const mockProcessAttachmentUploads = vi.fn();
vi.mock('@pagespace/lib/services/attachment-upload', () => ({
  processAttachmentUploads: (...args: unknown[]) => mockProcessAttachmentUploads(...args),
}));

// --- Imports under test ---------------------------------------------------------
import { POST } from '../route';
import { authenticateWithEnforcedContext } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions';
import { EnforcedAuthContext } from '@pagespace/lib/permissions/enforced-context';
import type { SessionClaims } from '@pagespace/lib/auth/session-service';

const SUCCESS_RESPONSE_BODY = { success: true, file: { id: 'h' }, storageInfo: undefined };

function makeRequest(): Request {
  // The route reads context.params and request.headers; formData parse happens inside
  // processAttachmentUpload (mocked here), so an empty body is fine.
  return new Request('http://localhost/api/channels/page-1/upload', { method: 'POST' });
}

function makeAuthContext(userId = 'user-1'): EnforcedAuthContext {
  const claims: SessionClaims = {
    sessionId: `session-${userId}`,
    userId,
    userRole: 'user',
    tokenVersion: 1,
    adminRoleVersion: 1,
    type: 'user',
    scopes: ['*'],
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  };

  return EnforcedAuthContext.fromSession(claims);
}

function makeAuthSuccess(authContext: EnforcedAuthContext) {
  return { ctx: authContext };
}

describe('POST /api/channels/[pageId]/upload (thin wrapper)', () => {
  let authContext: EnforcedAuthContext;

  beforeEach(() => {
    vi.clearAllMocks();
    authContext = makeAuthContext();
    vi.mocked(authenticateWithEnforcedContext).mockResolvedValue(makeAuthSuccess(authContext) as never);
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    mockPagesFindFirst.mockResolvedValue({
      id: 'page-1',
      type: 'CHANNEL',
      driveId: 'drive-1',
    });
    mockProcessAttachmentUploads.mockResolvedValue(
      new Response(JSON.stringify(SUCCESS_RESPONSE_BODY), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
  });

  it('delegates to processAttachmentUpload with a page AttachmentTarget when caller is allowed', async () => {
    const request = makeRequest();
    const res = await POST(request as never, { params: Promise.resolve({ pageId: 'page-1' }) });

    expect(res.status).toBe(200);
    expect(mockProcessAttachmentUploads).toHaveBeenCalledTimes(1);
    expect(mockProcessAttachmentUploads).toHaveBeenCalledWith({
      request,
      target: { type: 'page', pageId: 'page-1', driveId: 'drive-1' },
      authContext,
    });
  });

  it('returns 404 when the page does not exist (without calling the service)', async () => {
    mockPagesFindFirst.mockResolvedValue(undefined);

    const res = await POST(makeRequest() as never, { params: Promise.resolve({ pageId: 'page-1' }) });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toMatch(/not found/i);
    expect(mockProcessAttachmentUploads).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-channel page (without calling the service)', async () => {
    mockPagesFindFirst.mockResolvedValue({
      id: 'page-1',
      type: 'DOCUMENT',
      driveId: 'drive-1',
    });

    const res = await POST(makeRequest() as never, { params: Promise.resolve({ pageId: 'page-1' }) });

    expect(res.status).toBe(400);
    expect(mockProcessAttachmentUploads).not.toHaveBeenCalled();
  });

  it('returns 400 when the channel has no associated drive (without calling the service)', async () => {
    mockPagesFindFirst.mockResolvedValue({
      id: 'page-1',
      type: 'CHANNEL',
      driveId: null,
    });

    const res = await POST(makeRequest() as never, { params: Promise.resolve({ pageId: 'page-1' }) });

    expect(res.status).toBe(400);
    expect(mockProcessAttachmentUploads).not.toHaveBeenCalled();
  });

  it('returns 403 and emits authz.access.denied audit when the caller lacks edit permission', async () => {
    vi.mocked(canUserEditPage).mockResolvedValue(false);

    const res = await POST(makeRequest() as never, { params: Promise.resolve({ pageId: 'page-1' }) });

    expect(res.status).toBe(403);
    expect(mockProcessAttachmentUploads).not.toHaveBeenCalled();
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'authz.access.denied',
        userId: 'user-1',
        resourceType: 'channel_upload',
        resourceId: 'page-1',
      })
    );
  });

  it('returns 500 JSON when an unexpected wrapper-stage error is thrown', async () => {
    // Simulate an unexpected DB failure during the page lookup. The wrapper must
    // catch it and return the structured `{ error }` JSON contract — not bubble
    // a Next.js framework HTML error.
    mockPagesFindFirst.mockRejectedValue(new Error('boom'));

    const res = await POST(makeRequest() as never, { params: Promise.resolve({ pageId: 'page-1' }) });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe('Failed to upload file');
    expect(mockProcessAttachmentUploads).not.toHaveBeenCalled();
  });

  it('forwards the response from processAttachmentUpload unchanged', async () => {
    const customResponse = new Response(JSON.stringify({ success: true, file: { id: 'abc' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    mockProcessAttachmentUploads.mockResolvedValue(customResponse);

    const res = await POST(makeRequest() as never, { params: Promise.resolve({ pageId: 'page-1' }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.file.id).toBe('abc');
  });
});
