/**
 * DM upload route tests.
 *
 * Mirrors the channel upload wrapper contract: auth → conversation lookup →
 * email-verify gate → build target → delegate to processAttachmentUpload.
 * The pipeline (quota, semaphore, dedup, participant check, audit) is exercised
 * by the lib package's own tests; here we only verify the wrapper.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Auth -----------------------------------------------------------------------
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(
    (r: unknown) => typeof r === 'object' && r !== null && 'error' in r,
  ),
}));

// --- Email verification gate ---------------------------------------------------
vi.mock('@pagespace/lib/auth/verification-utils', () => ({
  isEmailVerified: vi.fn(),
}));

// --- Database boundary mocks ---------------------------------------------------
const mockDmConversationsFindFirst = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      dmConversations: {
        findFirst: (...args: unknown[]) => mockDmConversationsFindFirst(...args),
      },
    },
  },
}));
// Tagged tokens so the test can introspect the structure of the where clause
// the route builds. This pins the participant-scoped lookup against regression
// (a security fix; see Codex P2 review on PR #1215).
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  eq: vi.fn((column: unknown, value: unknown) => ({ op: 'eq', column, value })),
  or: vi.fn((...args: unknown[]) => ({ op: 'or', args })),
}));
vi.mock('@pagespace/db/schema/social', () => ({
  dmConversations: { id: 'dm_conversations.id' },
}));

// --- Logger + audit seams ------------------------------------------------------
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));
const mockAuditRequest = vi.fn();
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));

// --- Service seam --------------------------------------------------------------
const mockProcessAttachmentUpload = vi.fn();
vi.mock('@pagespace/lib/services/attachment-upload', () => ({
  processAttachmentUpload: (...args: unknown[]) =>
    mockProcessAttachmentUpload(...args),
}));

// --- Imports under test --------------------------------------------------------
import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';

const SUCCESS_RESPONSE_BODY = {
  success: true,
  file: { id: 'h', originalName: 'a.png', sanitizedName: 'a.png', size: 1, mimeType: 'image/png', contentHash: 'h' },
  storageInfo: undefined,
};

function makeRequest(): Request {
  return new Request('http://localhost/api/messages/conv-1/upload', {
    method: 'POST',
  });
}

function makeAuthSuccess(userId = 'user-1') {
  return {
    userId,
    role: 'user' as const,
    tokenVersion: 1,
    adminRoleVersion: 1,
    sessionId: 's',
    tokenType: 'session' as const,
  };
}

function successResponse(body: unknown = SUCCESS_RESPONSE_BODY): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/messages/[conversationId]/upload (thin wrapper)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(makeAuthSuccess());
    vi.mocked(isEmailVerified).mockResolvedValue(true);
    mockDmConversationsFindFirst.mockResolvedValue({
      id: 'conv-1',
      participant1Id: 'user-1',
      participant2Id: 'user-2',
    });
    mockProcessAttachmentUpload.mockResolvedValue(successResponse());
  });

  it('POST_dmUpload_validParticipantWithVerifiedEmail_delegatesToProcessAttachmentUpload_withConversationTarget', async () => {
    const request = makeRequest();
    const res = await POST(request as never, {
      params: Promise.resolve({ conversationId: 'conv-1' }),
    });

    expect(res.status).toBe(200);
    expect(mockProcessAttachmentUpload).toHaveBeenCalledTimes(1);
    expect(mockProcessAttachmentUpload).toHaveBeenCalledWith({
      request,
      target: { type: 'conversation', conversationId: 'conv-1' },
      userId: 'user-1',
    });
  });

  it('POST_dmUpload_unverifiedEmail_returns403_withRequiresEmailVerificationFlag_andDoesNotCallPipeline', async () => {
    vi.mocked(isEmailVerified).mockResolvedValue(false);

    const res = await POST(makeRequest() as never, {
      params: Promise.resolve({ conversationId: 'conv-1' }),
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.requiresEmailVerification).toBe(true);
    expect(body.error).toMatch(/email/i);
    expect(mockProcessAttachmentUpload).not.toHaveBeenCalled();
    // SIEM-visible denial: emit authz.access.denied with a discriminator so
    // the email-verification denial path is observable downstream.
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'authz.access.denied',
        userId: 'user-1',
        resourceType: 'dm_upload',
        resourceId: 'conv-1',
        details: expect.objectContaining({ reason: 'email_not_verified' }),
      }),
    );
  });

  it('POST_dmUpload_missingConversation_returns404_withoutCallingPipeline', async () => {
    mockDmConversationsFindFirst.mockResolvedValue(undefined);

    const res = await POST(makeRequest() as never, {
      params: Promise.resolve({ conversationId: 'conv-1' }),
    });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toMatch(/not found/i);
    expect(mockProcessAttachmentUpload).not.toHaveBeenCalled();
  });

  it('POST_dmUpload_nonParticipant_returns404_withoutCallingPipeline_toPreventExistenceLeak', async () => {
    // The wrapper queries dmConversations scoped to the calling user (id AND
    // participant), so a real DM the caller is not part of yields no row —
    // indistinguishable from a missing conversation. This prevents id
    // enumeration via a 404/403 status split. The pipeline's own participant
    // check (PermissionDeniedError → 403) remains the canonical authority for
    // any path that reaches it.
    mockDmConversationsFindFirst.mockResolvedValue(undefined);

    const res = await POST(makeRequest() as never, {
      params: Promise.resolve({ conversationId: 'conv-1' }),
    });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toMatch(/not found/i);
    expect(mockProcessAttachmentUpload).not.toHaveBeenCalled();
    // Email-verify is not consulted once the lookup fails — short-circuit.
    expect(vi.mocked(isEmailVerified)).not.toHaveBeenCalled();
  });

  it('POST_dmUpload_unauthenticated_returns401_fromAuthenticateRequestWithOptions_withoutCallingPipeline', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    } as never);

    const res = await POST(makeRequest() as never, {
      params: Promise.resolve({ conversationId: 'conv-1' }),
    });

    expect(res.status).toBe(401);
    expect(mockProcessAttachmentUpload).not.toHaveBeenCalled();
    expect(mockDmConversationsFindFirst).not.toHaveBeenCalled();
    expect(vi.mocked(isEmailVerified)).not.toHaveBeenCalled();
  });

  it('POST_dmUpload_pipelineReturns413_quotaExceeded_routePropagatesAs413', async () => {
    mockProcessAttachmentUpload.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Storage quota exceeded' }), {
        status: 413,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await POST(makeRequest() as never, {
      params: Promise.resolve({ conversationId: 'conv-1' }),
    });
    const body = await res.json();

    expect(res.status).toBe(413);
    expect(body.error).toMatch(/quota/i);
  });

  it('POST_dmUpload_pipelineReturns429_concurrentLimit_routePropagatesAs429', async () => {
    mockProcessAttachmentUpload.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Too many concurrent uploads.' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await POST(makeRequest() as never, {
      params: Promise.resolve({ conversationId: 'conv-1' }),
    });
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.error).toMatch(/too many/i);
  });

  it('POST_dmUpload_pipelineThrowsUnexpected_returns500_withStructuredError', async () => {
    mockProcessAttachmentUpload.mockRejectedValue(new Error('boom'));

    const res = await POST(makeRequest() as never, {
      params: Promise.resolve({ conversationId: 'conv-1' }),
    });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('POST_dmUpload_dbLookup_isScopedToConversationIdAndCallingParticipant_pinningCodexP2Fix', async () => {
    // Regression guard for the Codex P2 fix (50d6029e7): the wrapper must scope
    // findFirst to (id AND (participant1=user OR participant2=user)) so a
    // non-participant cannot distinguish "conversation does not exist" from
    // "you are not in this conversation". If a future change drops the
    // participant clauses, this test fails before the enumeration vector reopens.
    await POST(makeRequest() as never, {
      params: Promise.resolve({ conversationId: 'conv-1' }),
    });

    expect(mockDmConversationsFindFirst).toHaveBeenCalledTimes(1);
    const callArg = mockDmConversationsFindFirst.mock.calls[0][0] as {
      where: { op: string; args: unknown[] };
    };

    expect(callArg.where.op).toBe('and');
    const andArgs = callArg.where.args as Array<{ op: string; column?: unknown; value?: unknown; args?: unknown[] }>;

    // First clause: id == conversationId
    expect(andArgs[0]).toMatchObject({ op: 'eq', value: 'conv-1' });

    // Second clause: participant1Id == userId OR participant2Id == userId
    const orClause = andArgs[1];
    expect(orClause.op).toBe('or');
    const orArgs = orClause.args as Array<{ op: string; value: unknown }>;
    expect(orArgs).toHaveLength(2);
    expect(orArgs.every((c) => c.op === 'eq' && c.value === 'user-1')).toBe(true);
  });

  it('POST_dmUpload_responseShape_matchesChannelRoute_onSuccess', async () => {
    // The success body must keep the same top-level keys the channel route's
    // pipeline emits — `success`, `file`, `storageInfo` — so useAttachmentUpload
    // does not have to branch on target type.
    const channelLikeBody = {
      success: true,
      file: {
        id: 'hash-1',
        originalName: 'photo.png',
        sanitizedName: 'photo.png',
        size: 1234,
        mimeType: 'image/png',
        contentHash: 'hash-1',
      },
      storageInfo: {
        used: 100,
        quota: 1000,
        formattedUsed: '100 B',
        formattedQuota: '1 KB',
      },
    };
    mockProcessAttachmentUpload.mockResolvedValue(successResponse(channelLikeBody));

    const res = await POST(makeRequest() as never, {
      params: Promise.resolve({ conversationId: 'conv-1' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['file', 'storageInfo', 'success']);
    expect(body.file).toEqual(channelLikeBody.file);
    expect(body.storageInfo).toEqual(channelLikeBody.storageInfo);
  });
});
