import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateWithEnforcedContext: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isEnforcedAuthError: vi.fn((r: unknown) => typeof r === 'object' && r !== null && 'error' in r),
}));

const mockPagesFindFirst = vi.fn();
const mockDmFindFirst = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findFirst: (...a: unknown[]) => mockPagesFindFirst(...a) },
      dmConversations: { findFirst: (...a: unknown[]) => mockDmFindFirst(...a) },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn(), and: vi.fn(), or: vi.fn() }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'pages.id' } }));
vi.mock('@pagespace/db/schema/social', () => ({
  dmConversations: { id: 'dm.id', participant1Id: 'dm.p1', participant2Id: 'dm.p2' },
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({ canUserEditPage: vi.fn() }));
vi.mock('@pagespace/lib/auth/verification-utils', () => ({ isEmailVerified: vi.fn() }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

import { resolveChannelTarget, resolveConversationTarget } from '../attachment-route-helpers';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { EnforcedAuthContext } from '@pagespace/lib/permissions/enforced-context';
import type { SessionClaims } from '@pagespace/lib/auth/session-service';
import { authenticateWithEnforcedContext } from '@/lib/auth/request-auth';

function ctx(userId = 'user-1'): EnforcedAuthContext {
  const claims = {
    sessionId: `s-${userId}`,
    userId,
    userRole: 'user',
    tokenVersion: 1,
    adminRoleVersion: 1,
    type: 'user',
    scopes: ['*'],
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  } as unknown as SessionClaims;
  return EnforcedAuthContext.fromSession(claims);
}

const req = () => new Request('http://localhost/api/channels/page-1/upload/presign', { method: 'POST' });

describe('resolveChannelTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateWithEnforcedContext).mockResolvedValue({ ctx: ctx() } as never);
    mockPagesFindFirst.mockResolvedValue({ id: 'page-1', type: 'CHANNEL', driveId: 'drive-1' });
    vi.mocked(canUserEditPage).mockResolvedValue(true);
  });

  it('resolves a page target for an editable channel', async () => {
    const r = await resolveChannelTarget(req(), 'page-1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toEqual({ type: 'page', pageId: 'page-1', driveId: 'drive-1' });
  });

  it('surfaces the auth error response', async () => {
    vi.mocked(authenticateWithEnforcedContext).mockResolvedValue({ error: new Response(null, { status: 401 }) } as never);
    const r = await resolveChannelTarget(req(), 'page-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it('returns 404 when the page does not exist', async () => {
    mockPagesFindFirst.mockResolvedValue(undefined);
    const r = await resolveChannelTarget(req(), 'page-1');
    if (!r.ok) expect(r.response.status).toBe(404); else throw new Error('expected failure');
  });

  it('returns 400 when the page is not a channel', async () => {
    mockPagesFindFirst.mockResolvedValue({ id: 'page-1', type: 'DOCUMENT', driveId: 'drive-1' });
    const r = await resolveChannelTarget(req(), 'page-1');
    if (!r.ok) expect(r.response.status).toBe(400); else throw new Error('expected failure');
  });

  it('returns 403 when the caller cannot edit the channel', async () => {
    vi.mocked(canUserEditPage).mockResolvedValue(false);
    const r = await resolveChannelTarget(req(), 'page-1');
    if (!r.ok) expect(r.response.status).toBe(403); else throw new Error('expected failure');
  });
});

describe('resolveConversationTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateWithEnforcedContext).mockResolvedValue({ ctx: ctx() } as never);
    mockDmFindFirst.mockResolvedValue({ id: 'conv-1', participant1Id: 'user-1', participant2Id: 'user-2' });
    vi.mocked(isEmailVerified).mockResolvedValue(true);
  });

  it('resolves a conversation target for a verified participant', async () => {
    const r = await resolveConversationTarget(req(), 'conv-1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toEqual({ type: 'conversation', conversationId: 'conv-1' });
  });

  it('returns 404 when the caller is not a participant (or it does not exist)', async () => {
    mockDmFindFirst.mockResolvedValue(undefined);
    const r = await resolveConversationTarget(req(), 'conv-1');
    if (!r.ok) expect(r.response.status).toBe(404); else throw new Error('expected failure');
  });

  it('returns 403 when the email is not verified', async () => {
    vi.mocked(isEmailVerified).mockResolvedValue(false);
    const r = await resolveConversationTarget(req(), 'conv-1');
    if (!r.ok) expect(r.response.status).toBe(403); else throw new Error('expected failure');
  });
});
