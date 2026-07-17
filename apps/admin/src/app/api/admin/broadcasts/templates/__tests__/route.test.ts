import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { createId } from '@paralleldrive/cuid2';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { generateCSRFToken } from '@pagespace/lib/auth/csrf-utils';

/** Tests for GET/POST /api/admin/broadcasts/templates — the phase-1 template library. */

vi.mock('@pagespace/lib/repositories/broadcast-repository', () => ({
  broadcastRepository: {
    listTemplates: vi.fn(),
    createTemplate: vi.fn(),
  },
}));

import { GET, POST } from '../route';
import { broadcastRepository } from '@pagespace/lib/repositories/broadcast-repository';

const mockRepo = vi.mocked(broadcastRepository);

describe('/api/admin/broadcasts/templates', () => {
  let adminUserId: string;
  const adminSessionToken = 'mock_admin_session_token';
  const mockSessionId = 'mock-session-id';
  let adminCsrfToken: string;

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

  it('GET lists active templates', async () => {
    const createdAt = new Date('2026-07-01T00:00:00Z');
    mockRepo.listTemplates.mockResolvedValue([
      {
        id: 'tpl_1',
        name: 'Monthly',
        subject: 'Monthly update',
        bodyMarkdown: 'Body',
        isActive: true,
        createdByUserId: null,
        createdAt,
        updatedAt: createdAt,
      },
    ]);

    const response = await GET(
      new NextRequest('http://localhost/api/admin/broadcasts/templates', {
        headers: { Cookie: `admin_session=${adminSessionToken}` },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRepo.listTemplates).toHaveBeenCalledWith(true);
    expect(body.templates).toEqual([
      {
        id: 'tpl_1',
        name: 'Monthly',
        subject: 'Monthly update',
        bodyMarkdown: 'Body',
        isActive: true,
        createdAt: createdAt.toISOString(),
        updatedAt: createdAt.toISOString(),
      },
    ]);
  });

  it('POST creates a template attributed to the admin', async () => {
    const createdAt = new Date('2026-07-16T00:00:00Z');
    mockRepo.createTemplate.mockResolvedValue({
      id: 'tpl_2',
      name: 'Launch',
      subject: 'We shipped',
      bodyMarkdown: 'Details…',
      isActive: true,
      createdByUserId: 'admin',
      createdAt,
      updatedAt: createdAt,
    });

    const response = await POST(
      new NextRequest('http://localhost/api/admin/broadcasts/templates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `admin_session=${adminSessionToken}`,
          'X-CSRF-Token': adminCsrfToken,
        },
        body: JSON.stringify({ name: 'Launch', subject: 'We shipped', bodyMarkdown: 'Details…' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.template.id).toBe('tpl_2');
    expect(mockRepo.createTemplate).toHaveBeenCalledWith({
      name: 'Launch',
      subject: 'We shipped',
      bodyMarkdown: 'Details…',
      isActive: true,
      createdByUserId: adminUserId,
    });
  });

  it('POST rejects a template without a body', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/admin/broadcasts/templates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `admin_session=${adminSessionToken}`,
          'X-CSRF-Token': adminCsrfToken,
        },
        body: JSON.stringify({ name: 'Launch', subject: 'We shipped' }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mockRepo.createTemplate).not.toHaveBeenCalled();
  });
});
