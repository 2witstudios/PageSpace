import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createId } from '@paralleldrive/cuid2';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { generateCSRFToken } from '@pagespace/lib/auth/csrf-utils';

/**
 * Tests for POST/GET /api/admin/broadcasts.
 *
 * The contract under test (frozen for the admin UI):
 *  - dry-run returns { dryRun, audienceCount, previewHtml, subject } and touches
 *    NOTHING durable — no row, no recipients, no processor job;
 *  - live create runs create → enqueueBroadcast → markQueued and returns
 *    { broadcastId, jobId } (202), with markFailed when the enqueue throws;
 *  - non-admin callers are rejected by withAdminAuth;
 *  - malformed bodies are rejected by the shared Zod schema.
 *
 * AUTH IS MOCKED ALL THE WAY DOWN, AND MUST STAY THAT WAY.
 * This suite used to follow the gift-subscription style — insert a real admin
 * row and let `validateAdminAccess` read it back. That style belongs to a file
 * vitest.config.ts EXCLUDES as an integration test; here it made these tests
 * depend on a row in the SHARED test database surviving the request. It does
 * not. `turbo run test:coverage` declares no ordering between packages, so
 * `apps/admin` and `@pagespace/db` run at the same time against one database,
 * and packages/db/src/test/activity-logs-compliance.test.ts ends every one of
 * its eight tests with
 *
 *     TRUNCATE TABLE activity_logs, page_permissions, pages, drive_members,
 *                    drives, users CASCADE
 *
 * Land one of those between this suite's insert and its request and
 * `validateAdminAccess` reports `user_not_found` → 403. That is exactly how
 * `templates > GET lists active templates` failed CI on PR #2365, a PR that
 * touches no admin file. Mocking `@/lib/auth/admin-role` removes the shared row
 * from the picture entirely. `withAdminAuth` itself — session-type scoping, CSRF,
 * and every `validateAdminAccess` denial reason — is covered without a database
 * in src/lib/auth/__tests__/auth.test.ts.
 *
 * A mocked sessionService and a real CSRF token complete the picture. The
 * repository, audience count, and enqueue helper are mocked — content resolution
 * and email rendering run REAL so previewHtml is evidence about the exact email
 * the worker would ship.
 */

vi.mock('@/lib/auth/admin-role', () => ({
  validateAdminAccess: vi.fn(async () => ({ isValid: true })),
  updateUserRole: vi.fn(),
}));

vi.mock('@pagespace/lib/repositories/broadcast-repository', () => ({
  broadcastRepository: {
    create: vi.fn(),
    findById: vi.fn(),
    markQueued: vi.fn(),
    markFailed: vi.fn(),
    updateStatus: vi.fn(),
    incrementAttempts: vi.fn(),
    appendStepResult: vi.fn(),
    updateCounts: vi.fn(),
    listByStatus: vi.fn(),
    listRecent: vi.fn(),
    loadAlreadySentUserIds: vi.fn(),
    loadAlreadySentEmails: vi.fn(),
    createBroadcastLedger: vi.fn(),
    claimRecipient: vi.fn(),
    recordSent: vi.fn(),
    recordSkip: vi.fn(),
    recordFailure: vi.fn(),
    countRecipientsByStatus: vi.fn(),
    listTemplates: vi.fn(),
    findTemplateById: vi.fn(),
    createTemplate: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/services/broadcast/audience', () => ({
  countAudience: vi.fn(),
}));

vi.mock('@/lib/broadcast/enqueue', async () => {
  const actual = await vi.importActual<typeof import('@/lib/broadcast/enqueue')>('@/lib/broadcast/enqueue');
  return {
    BroadcastNotEnqueuedError: actual.BroadcastNotEnqueuedError,
    BroadcastEnqueueUnconfirmedError: actual.BroadcastEnqueueUnconfirmedError,
    enqueueBroadcast: vi.fn(),
  };
});

import { POST, GET } from '../route';
import { broadcastRepository } from '@pagespace/lib/repositories/broadcast-repository';
import { countAudience } from '@pagespace/lib/services/broadcast/audience';
import { validateAdminAccess } from '@/lib/auth/admin-role';
import {
  BroadcastEnqueueUnconfirmedError,
  BroadcastNotEnqueuedError,
  enqueueBroadcast,
} from '@/lib/broadcast/enqueue';

const mockRepo = vi.mocked(broadcastRepository);
const mockCountAudience = vi.mocked(countAudience);
const mockEnqueue = vi.mocked(enqueueBroadcast);

describe('/api/admin/broadcasts', () => {
  let adminUserId: string;
  const adminSessionToken = 'mock_admin_session_token';
  const mockSessionId = 'mock-session-id';
  let adminCsrfToken: string;

  const authedHeaders = () => ({
    'Content-Type': 'application/json',
    Cookie: `admin_session=${adminSessionToken}`,
    'X-CSRF-Token': adminCsrfToken,
  });

  const postRequest = (body: unknown, headers?: Record<string, string>) =>
    new NextRequest('http://localhost/api/admin/broadcasts', {
      method: 'POST',
      headers: headers ?? authedHeaders(),
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    vi.clearAllMocks();

    adminUserId = createId();
    vi.mocked(validateAdminAccess).mockResolvedValue({ isValid: true });

    vi.spyOn(sessionService, 'validateSession').mockResolvedValue({
      sessionId: mockSessionId,
      userId: adminUserId,
      userRole: 'admin',
      tokenVersion: 1,
      adminRoleVersion: 0,
      type: 'user',
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 3600000),
    });
    adminCsrfToken = generateCSRFToken(mockSessionId);

    // The live path consults the active-duplicate guard before creating.
    mockRepo.listByStatus.mockResolvedValue([]);
  });

  describe('POST — dry run', () => {
    it('returns audienceCount + previewHtml and touches nothing durable', async () => {
      mockCountAudience.mockResolvedValue(220);

      const response = await POST(
        postRequest({
          subject: 'Launch update',
          contentMode: 'compose',
          bodyMarkdown: '# Hello\n\nWe [shipped](https://pagespace.ai/blog) something.',
          audienceDefinition: { planTiers: ['pro'] },
          dryRun: true,
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.dryRun).toBe(true);
      expect(body.audienceCount).toBe(220);
      expect(body.subject).toBe('Launch update');
      // The REAL renderer ran: authored content + mandatory unsubscribe footer.
      expect(body.previewHtml).toContain('Hello');
      expect(body.previewHtml).toContain('https://pagespace.ai/blog');
      expect(body.previewHtml.toLowerCase()).toContain('unsubscribe');

      expect(mockCountAudience).toHaveBeenCalledWith({ planTiers: ['pro'] });

      // Nothing durable: no row, no job, no recipient ledger writes.
      expect(mockRepo.create).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(mockRepo.markQueued).not.toHaveBeenCalled();
      expect(mockRepo.recordSent).not.toHaveBeenCalled();
      expect(mockRepo.recordSkip).not.toHaveBeenCalled();
      expect(mockRepo.recordFailure).not.toHaveBeenCalled();
      expect(mockRepo.claimRecipient).not.toHaveBeenCalled();
      expect(mockRepo.createBroadcastLedger).not.toHaveBeenCalled();
    });

    it('resolves template content for a template dry run', async () => {
      mockCountAudience.mockResolvedValue(3);
      mockRepo.findTemplateById.mockResolvedValue({
        id: 'tpl_1',
        name: 'Monthly',
        subject: 'Template subject',
        bodyMarkdown: 'Template **body** text',
        isActive: true,
        createdByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const response = await POST(
        postRequest({
          contentMode: 'template',
          templateId: 'tpl_1',
          dryRun: true,
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      // No override subject supplied → the template's own subject wins.
      expect(body.subject).toBe('Template subject');
      expect(body.previewHtml).toContain('body');
      expect(mockRepo.create).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('rejects a dry run against an inactive template', async () => {
      mockRepo.findTemplateById.mockResolvedValue({
        id: 'tpl_1',
        name: 'Retired',
        subject: 'Old',
        bodyMarkdown: 'Old body',
        isActive: false,
        createdByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const response = await POST(
        postRequest({ contentMode: 'template', templateId: 'tpl_1', dryRun: true }),
      );

      expect(response.status).toBe(400);
      expect(mockCountAudience).not.toHaveBeenCalled();
    });
  });

  describe('POST — live create', () => {
    const liveBody = {
      subject: 'Launch update',
      contentMode: 'compose',
      bodyMarkdown: 'We shipped something.',
      audienceDefinition: {},
      dryRun: false,
      sendLimit: 5,
      delayMs: 120,
    };

    it('creates the row, enqueues the job, and marks it queued', async () => {
      mockRepo.create.mockResolvedValue({ id: 'bc_1' } as never);
      mockEnqueue.mockResolvedValue({ jobId: 'job_1' });
      mockRepo.markQueued.mockResolvedValue(1);

      const response = await POST(postRequest(liveBody));
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(body).toEqual({ broadcastId: 'bc_1', jobId: 'job_1', enqueue: 'confirmed' });

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Launch update',
          engine: 'transactional',
          contentMode: 'compose',
          bodyMarkdown: 'We shipped something.',
          templateId: null,
          dryRun: false,
          sendLimit: 5,
          delayMs: 120,
          createdByUserId: adminUserId,
        }),
      );
      expect(mockEnqueue).toHaveBeenCalledWith({ broadcastId: 'bc_1', callerUserId: adminUserId });
      expect(mockRepo.markQueued).toHaveBeenCalledWith('bc_1', 'job_1');
      expect(mockRepo.markFailed).not.toHaveBeenCalled();
    });

    it('drops a stale templateId from a compose-mode create', async () => {
      mockRepo.create.mockResolvedValue({ id: 'bc_1' } as never);
      mockEnqueue.mockResolvedValue({ jobId: 'job_1' });
      mockRepo.markQueued.mockResolvedValue(1);

      const response = await POST(postRequest({ ...liveBody, templateId: 'tpl_deleted' }));

      expect(response.status).toBe(202);
      // A compose send never read the template, so it must not reference one —
      // a stale/deleted id would otherwise break the insert on the FK or record
      // a template this send never used.
      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ contentMode: 'compose', templateId: null }),
      );
    });

    it('marks the broadcast failed when the enqueue definitely did not land', async () => {
      mockRepo.create.mockResolvedValue({ id: 'bc_1' } as never);
      mockEnqueue.mockRejectedValue(new BroadcastNotEnqueuedError('processor refused: 401'));
      mockRepo.markFailed.mockResolvedValue(1);

      const response = await POST(postRequest(liveBody));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.broadcastId).toBe('bc_1');
      expect(mockRepo.markFailed).toHaveBeenCalledWith(
        'bc_1',
        expect.stringContaining('processor refused'),
      );
      expect(mockRepo.markQueued).not.toHaveBeenCalled();
    });

    it('does NOT fail the row on an unconfirmed enqueue — a job may exist', async () => {
      mockRepo.create.mockResolvedValue({ id: 'bc_1' } as never);
      mockEnqueue.mockRejectedValue(
        new BroadcastEnqueueUnconfirmedError('timeout; retry: timeout'),
      );
      mockRepo.appendStepResult.mockResolvedValue(undefined);

      const response = await POST(postRequest(liveBody));
      const body = await response.json();

      // 202, not 500: a 500 invites a retried POST, which creates a FRESH row
      // with a fresh singletonKey — a genuine second mass send.
      expect(response.status).toBe(202);
      expect(body).toEqual({ broadcastId: 'bc_1', jobId: null, enqueue: 'unconfirmed' });
      expect(mockRepo.markFailed).not.toHaveBeenCalled();
      expect(mockRepo.markQueued).not.toHaveBeenCalled();
      expect(mockRepo.appendStepResult).toHaveBeenCalledWith(
        'bc_1',
        expect.objectContaining({ step: 'enqueue', status: 'failed' }),
      );
    });

    it('reconciles when markFailed reports the worker already advanced the row', async () => {
      mockRepo.create.mockResolvedValue({ id: 'bc_1' } as never);
      mockEnqueue.mockRejectedValue(new BroadcastNotEnqueuedError('processor refused: 400'));
      mockRepo.markFailed.mockResolvedValue(0);
      mockRepo.findById.mockResolvedValue({ id: 'bc_1', jobId: 'job_prior', status: 'in_progress' } as never);

      const response = await POST(postRequest(liveBody));
      const body = await response.json();

      // markFailed's guard refusing means a job exists and is sending — report
      // that send instead of a retryable failure.
      expect(response.status).toBe(202);
      expect(body).toEqual({ broadcastId: 'bc_1', jobId: 'job_prior', enqueue: 'confirmed' });
    });

    it('still returns 202 when markQueued bookkeeping fails after a successful enqueue', async () => {
      mockRepo.create.mockResolvedValue({ id: 'bc_1' } as never);
      mockEnqueue.mockResolvedValue({ jobId: 'job_1' });
      mockRepo.markQueued.mockRejectedValue(new Error('db blip'));

      const response = await POST(postRequest(liveBody));
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(body).toEqual({ broadcastId: 'bc_1', jobId: 'job_1', enqueue: 'confirmed' });
      expect(mockRepo.markFailed).not.toHaveBeenCalled();
    });

    it('treats a deduped enqueue (job already queued) as confirmed with an unknown jobId', async () => {
      mockRepo.create.mockResolvedValue({ id: 'bc_1' } as never);
      mockEnqueue.mockResolvedValue({ jobId: null });

      const response = await POST(postRequest(liveBody));
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(body).toEqual({ broadcastId: 'bc_1', jobId: null, enqueue: 'confirmed' });
      expect(mockRepo.markQueued).not.toHaveBeenCalled();
    });

    it('refuses a live send on the unshipped resend_broadcast engine at the schema', async () => {
      const response = await POST(postRequest({ ...liveBody, engine: 'resend_broadcast' }));
      const body = await response.json();

      // Schema-level, so the composer form flags it at validation time too.
      expect(response.status).toBe(400);
      expect(body.details.engine).toBeDefined();
      expect(mockRepo.create).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('allows a DRY RUN on the resend_broadcast engine — preview is engine-independent', async () => {
      mockCountAudience.mockResolvedValue(1);

      const response = await POST(
        postRequest({ ...liveBody, engine: 'resend_broadcast', dryRun: true }),
      );

      expect(response.status).toBe(200);
    });

    it('409s a live create whose subject matches a still-active broadcast', async () => {
      mockRepo.listByStatus.mockResolvedValue([
        { id: 'bc_active', subject: 'Launch update', status: 'in_progress', dryRun: false } as never,
      ]);

      const response = await POST(postRequest(liveBody));
      const body = await response.json();

      // A double-clicked Send or proxy-retried POST creates a FRESH row with a
      // fresh singletonKey — nothing downstream dedupes it, so the guard here
      // is what stands between the audience and a double blast.
      expect(response.status).toBe(409);
      expect(body.duplicateOf).toBe('bc_active');
      expect(mockRepo.create).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
      // 'failed' is queried as active: the worker writes failed + rethrows so
      // pg-boss retries — a failed row is often a live send between attempts.
      expect(mockRepo.listByStatus).toHaveBeenCalledWith([
        'pending',
        'queued',
        'in_progress',
        'paused',
        'failed',
      ]);
    });

    it('409s a same-subject create while a FAILED broadcast awaits its pg-boss retry', async () => {
      mockRepo.listByStatus.mockResolvedValue([
        { id: 'bc_failed', subject: 'Launch update', status: 'failed', dryRun: false } as never,
      ]);

      const response = await POST(postRequest(liveBody));
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.duplicateOf).toBe('bc_failed');
      expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('lets allowDuplicate deliberately bypass the active-duplicate guard', async () => {
      mockRepo.listByStatus.mockResolvedValue([
        { id: 'bc_active', subject: 'Launch update', status: 'in_progress', dryRun: false } as never,
      ]);
      mockRepo.create.mockResolvedValue({ id: 'bc_2' } as never);
      mockEnqueue.mockResolvedValue({ jobId: 'job_2' });
      mockRepo.markQueued.mockResolvedValue(1);

      const response = await POST(postRequest({ ...liveBody, allowDuplicate: true }));

      expect(response.status).toBe(202);
      expect(mockRepo.create).toHaveBeenCalled();
    });
  });

  describe('POST — validation', () => {
    it('rejects a compose broadcast without a body', async () => {
      const response = await POST(
        postRequest({ subject: 'No body', contentMode: 'compose', dryRun: true }),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.details.bodyMarkdown).toBeDefined();
      expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('rejects a template broadcast without a templateId', async () => {
      const response = await POST(postRequest({ contentMode: 'template', dryRun: true }));

      expect(response.status).toBe(400);
    });

    it('rejects a body that does not state dryRun', async () => {
      const response = await POST(
        postRequest({ subject: 'Hi', contentMode: 'compose', bodyMarkdown: 'x' }),
      );

      expect(response.status).toBe(400);
    });

    it('rejects an inverted signup window', async () => {
      const response = await POST(
        postRequest({
          subject: 'Hi',
          contentMode: 'compose',
          bodyMarkdown: 'x',
          dryRun: true,
          audienceDefinition: {
            signupAfter: '2026-02-01T00:00:00Z',
            signupBefore: '2026-01-01T00:00:00Z',
          },
        }),
      );

      expect(response.status).toBe(400);
    });
  });

  describe('POST — auth', () => {
    it('rejects an unauthenticated caller', async () => {
      const response = await POST(
        postRequest(
          { subject: 'Hi', contentMode: 'compose', bodyMarkdown: 'x', dryRun: true },
          { 'Content-Type': 'application/json' },
        ),
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Forbidden: Admin access required');
      expect(mockRepo.create).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('rejects a mutating call without a CSRF token', async () => {
      const response = await POST(
        postRequest(
          { subject: 'Hi', contentMode: 'compose', bodyMarkdown: 'x', dryRun: true },
          {
            'Content-Type': 'application/json',
            Cookie: `admin_session=${adminSessionToken}`,
          },
        ),
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.code).toBe('CSRF_TOKEN_MISSING');
    });
  });

  describe('GET — list', () => {
    it('returns the frozen list shape', async () => {
      const createdAt = new Date('2026-07-16T12:00:00Z');
      mockRepo.listRecent.mockResolvedValue([
        {
          id: 'bc_1',
          subject: 'Launch update',
          status: 'completed',
          engine: 'transactional',
          dryRun: false,
          totalTargeted: 220,
          sentCount: 218,
          skippedCount: 2,
          failedCount: 0,
          createdAt,
        } as never,
      ]);

      const response = await GET(
        new NextRequest('http://localhost/api/admin/broadcasts', {
          headers: { Cookie: `admin_session=${adminSessionToken}` },
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.broadcasts).toEqual([
        {
          id: 'bc_1',
          subject: 'Launch update',
          status: 'completed',
          engine: 'transactional',
          dryRun: false,
          totalTargeted: 220,
          sentCount: 218,
          skippedCount: 2,
          failedCount: 0,
          createdAt: createdAt.toISOString(),
        },
      ]);
    });
  });
});
