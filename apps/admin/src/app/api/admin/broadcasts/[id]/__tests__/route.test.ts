import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { createId } from '@paralleldrive/cuid2';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { generateCSRFToken } from '@pagespace/lib/auth/csrf-utils';
import type { EmailBroadcast } from '@pagespace/db/schema/email-broadcasts';

/**
 * Tests for GET/POST /api/admin/broadcasts/[id] — the progress-polling shape and
 * the cancel/pause intervention, including the terminal-state guard (a finished
 * broadcast reports 409 with its real status instead of being dragged back).
 */

vi.mock('@pagespace/lib/repositories/broadcast-repository', () => ({
  broadcastRepository: {
    findById: vi.fn(),
    updateStatus: vi.fn(),
    appendStepResult: vi.fn(),
  },
}));

import { GET, POST } from '../route';
import { broadcastRepository } from '@pagespace/lib/repositories/broadcast-repository';

const mockRepo = vi.mocked(broadcastRepository);

const baseBroadcast = {
  id: 'bc_1',
  subject: 'Launch update',
  engine: 'transactional',
  contentMode: 'compose',
  templateId: null,
  bodyMarkdown: 'Body',
  notificationType: 'PRODUCT_UPDATE',
  audienceDefinition: {},
  status: 'in_progress',
  dryRun: false,
  sendLimit: null,
  delayMs: 120,
  totalTargeted: 100,
  sentCount: 40,
  skippedCount: 3,
  failedCount: 1,
  stepResults: [{ step: 'link-check', status: 'ok', at: '2026-07-16T12:00:00.000Z' }],
  jobId: 'job_1',
  attempts: 1,
  lastError: null,
  blockedReason: null,
  createdByUserId: null,
  startedAt: new Date('2026-07-16T12:00:00Z'),
  completedAt: null,
  createdAt: new Date('2026-07-16T11:59:00Z'),
  updatedAt: new Date('2026-07-16T12:00:00Z'),
} as EmailBroadcast;

describe('/api/admin/broadcasts/[id]', () => {
  let adminUserId: string;
  const adminSessionToken = 'mock_admin_session_token';
  const mockSessionId = 'mock-session-id';
  let adminCsrfToken: string;

  const context = { params: Promise.resolve({ id: 'bc_1' }) };

  const getRequest = () =>
    new NextRequest('http://localhost/api/admin/broadcasts/bc_1', {
      headers: { Cookie: `admin_session=${adminSessionToken}` },
    });

  const postRequest = (body: unknown) =>
    new NextRequest('http://localhost/api/admin/broadcasts/bc_1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `admin_session=${adminSessionToken}`,
        'X-CSRF-Token': adminCsrfToken,
      },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    vi.clearAllMocks();

    const [adminUser] = await db
      .insert(users)
      .values({
        id: createId(),
        name: 'Broadcast Admin',
        email: `broadcast-admin-${Date.now()}-${createId().slice(0, 6)}@example.com`,
        provider: 'email',
        role: 'admin',
        tokenVersion: 1,
        adminRoleVersion: 0,
      })
      .returning();
    adminUserId = adminUser.id;

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
  });

  afterEach(async () => {
    try {
      await db.delete(users).where(eq(users.id, adminUserId));
    } catch {
      // Swallow cleanup errors to avoid masking test failures
    }
  });

  describe('GET — progress polling', () => {
    it('returns the frozen status shape', async () => {
      mockRepo.findById.mockResolvedValue(baseBroadcast);

      const response = await GET(getRequest(), context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        id: 'bc_1',
        subject: 'Launch update',
        status: 'in_progress',
        engine: 'transactional',
        contentMode: 'compose',
        dryRun: false,
        sendLimit: null,
        delayMs: 120,
        totalTargeted: 100,
        sentCount: 40,
        skippedCount: 3,
        failedCount: 1,
        attempts: 1,
        lastError: null,
        blockedReason: null,
        completedAt: null,
      });
      expect(body.stepResults).toHaveLength(1);
    });

    it('404s for an unknown broadcast', async () => {
      mockRepo.findById.mockResolvedValue(null);

      const response = await GET(getRequest(), context);

      expect(response.status).toBe(404);
    });
  });

  describe('POST — cancel/pause', () => {
    it('cancels an active broadcast and records the reason', async () => {
      mockRepo.findById.mockResolvedValue(baseBroadcast);
      mockRepo.updateStatus.mockResolvedValue(1);

      const response = await POST(postRequest({ action: 'cancel', reason: 'Wrong audience' }), context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ id: 'bc_1', status: 'cancelled' });
      expect(mockRepo.updateStatus).toHaveBeenCalledWith(
        'bc_1',
        'cancelled',
        expect.objectContaining({ completedAt: expect.any(Date) }),
        { unlessStatus: ['completed', 'cancelled'] },
      );
      expect(mockRepo.appendStepResult).toHaveBeenCalledWith(
        'bc_1',
        expect.objectContaining({ step: 'cancel', detail: 'Wrong audience' }),
      );
    });

    it('pauses an active broadcast', async () => {
      mockRepo.findById.mockResolvedValue(baseBroadcast);
      mockRepo.updateStatus.mockResolvedValue(1);

      const response = await POST(postRequest({ action: 'pause', reason: 'Checking a complaint' }), context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ id: 'bc_1', status: 'paused' });
      expect(mockRepo.updateStatus).toHaveBeenCalledWith('bc_1', 'paused', {}, {
        unlessStatus: ['completed', 'cancelled'],
      });
    });

    it('cancels a FAILED broadcast — pg-boss may still be retrying it', async () => {
      mockRepo.findById.mockResolvedValue({ ...baseBroadcast, status: 'failed' });
      mockRepo.updateStatus.mockResolvedValue(1);

      const response = await POST(postRequest({ action: 'cancel', reason: 'Stop the retries' }), context);
      const body = await response.json();

      // The worker writes 'failed' + rethrows so pg-boss retries; a 'failed'
      // row is often a live send between attempts. Refusing to cancel it would
      // let the next retry resume mailing after the operator said stop.
      expect(response.status).toBe(200);
      expect(body).toEqual({ id: 'bc_1', status: 'cancelled' });
    });

    it('returns 200 when the step-result note fails — the status write IS the intervention', async () => {
      mockRepo.findById.mockResolvedValue(baseBroadcast);
      mockRepo.updateStatus.mockResolvedValue(1);
      mockRepo.appendStepResult.mockRejectedValue(new Error('db blip'));

      const response = await POST(postRequest({ action: 'cancel', reason: 'Wrong audience' }), context);
      const body = await response.json();

      // A 500 here would misreport a cancel that DID land, and its retry hits
      // the no-op branch anyway. The reason survives in the audit log.
      expect(response.status).toBe(200);
      expect(body).toEqual({ id: 'bc_1', status: 'cancelled' });
    });

    it('409s when the broadcast reached a terminal state first', async () => {
      mockRepo.findById.mockResolvedValue({ ...baseBroadcast, status: 'completed' });
      mockRepo.updateStatus.mockResolvedValue(0);

      const response = await POST(postRequest({ action: 'cancel', reason: 'Too late' }), context);
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.status).toBe('completed');
      expect(mockRepo.appendStepResult).not.toHaveBeenCalled();
    });

    it('treats repeating a landed intervention as a no-op', async () => {
      mockRepo.findById.mockResolvedValue({ ...baseBroadcast, status: 'cancelled' });

      const response = await POST(postRequest({ action: 'cancel', reason: 'Again' }), context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ id: 'bc_1', status: 'cancelled' });
      expect(mockRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('rejects an action without a reason', async () => {
      const response = await POST(postRequest({ action: 'cancel' }), context);

      expect(response.status).toBe(400);
      expect(mockRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('404s for an unknown broadcast', async () => {
      mockRepo.findById.mockResolvedValue(null);

      const response = await POST(postRequest({ action: 'cancel', reason: 'Gone' }), context);

      expect(response.status).toBe(404);
    });
  });
});
