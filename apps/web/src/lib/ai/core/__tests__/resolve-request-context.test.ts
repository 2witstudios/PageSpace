import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';
import type { ContextRef } from '@/lib/ai/shared/buildContextRef';
import type { BreadcrumbPage } from '@/lib/pages/get-page-breadcrumb-trail';

vi.mock('@/lib/auth/principal-permissions', () => ({
  canPrincipalViewPage: vi.fn(),
  isPrincipalDriveMember: vi.fn(),
}));

vi.mock('@/lib/pages/get-page-breadcrumb-trail', () => ({
  getPageBreadcrumbTrail: vi.fn(),
}));

const dbLimitMock = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: dbLimitMock,
        })),
      })),
    })),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  drives: 'drives_table',
}));

import { resolveRequestContext } from '../resolve-request-context';
import { canPrincipalViewPage, isPrincipalDriveMember } from '@/lib/auth/principal-permissions';
import { getPageBreadcrumbTrail } from '@/lib/pages/get-page-breadcrumb-trail';

const AUTH: SessionAuthResult = {
  userId: 'user-1',
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'session-1',
  role: 'user',
  adminRoleVersion: 0,
};

const trailPage = (overrides: Partial<BreadcrumbPage>): BreadcrumbPage => ({
  id: 'page-x',
  title: 'Page X',
  type: 'DOCUMENT',
  parentId: null,
  driveId: 'drive-1',
  drive: { id: 'drive-1', slug: 'engineering', name: 'Engineering' },
  ...overrides,
});

describe('resolveRequestContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given no contextRef, should return null', async () => {
    expect(await resolveRequestContext(AUTH, undefined)).toBeNull();
  });

  it("given routeType 'other', should return null (no page/drive context)", async () => {
    const ref: ContextRef = { routeType: 'other' };
    expect(await resolveRequestContext(AUTH, ref)).toBeNull();
    expect(canPrincipalViewPage).not.toHaveBeenCalled();
  });

  it("given routeType 'dm', should return null (DMs are not pages)", async () => {
    const ref: ContextRef = { routeType: 'dm', dmConversationId: 'conv-1' };
    expect(await resolveRequestContext(AUTH, ref)).toBeNull();
  });

  it("given routeType 'page' with no pageId, should return null", async () => {
    const ref: ContextRef = { routeType: 'page' };
    expect(await resolveRequestContext(AUTH, ref)).toBeNull();
    expect(canPrincipalViewPage).not.toHaveBeenCalled();
  });

  // The core security property this leaf exists for: a client-claimed contextRef
  // pointing at a page the caller cannot view must never leak that page's
  // title/breadcrumbs into the AI prompt.
  it("given routeType 'page' the caller CANNOT view, should DENY and return null", async () => {
    vi.mocked(canPrincipalViewPage).mockResolvedValue(false);
    const ref: ContextRef = { routeType: 'page', pageId: 'secret-page' };

    expect(await resolveRequestContext(AUTH, ref)).toBeNull();
    expect(canPrincipalViewPage).toHaveBeenCalledWith(AUTH, 'secret-page');
    expect(getPageBreadcrumbTrail).not.toHaveBeenCalled();
  });

  it("given routeType 'page' the caller CAN view but the trail is empty (page gone), should return null", async () => {
    vi.mocked(canPrincipalViewPage).mockResolvedValue(true);
    vi.mocked(getPageBreadcrumbTrail).mockResolvedValue([]);
    const ref: ContextRef = { routeType: 'page', pageId: 'page-x' };

    expect(await resolveRequestContext(AUTH, ref)).toBeNull();
  });

  it("given routeType 'page' the caller CAN view, should resolve currentPage/currentDrive/breadcrumbs from the trail", async () => {
    vi.mocked(canPrincipalViewPage).mockResolvedValue(true);
    vi.mocked(getPageBreadcrumbTrail).mockResolvedValue([
      trailPage({ id: 'root', title: 'Root Folder' }),
      trailPage({ id: 'page-x', title: 'Page X', parentId: 'root' }),
    ]);
    const ref: ContextRef = { routeType: 'page', pageId: 'page-x' };

    expect(await resolveRequestContext(AUTH, ref)).toEqual({
      currentPage: {
        id: 'page-x',
        title: 'Page X',
        type: 'DOCUMENT',
        path: '/engineering/Root Folder/Page X',
      },
      currentDrive: { id: 'drive-1', name: 'Engineering', slug: 'engineering' },
      breadcrumbs: ['Engineering', 'Root Folder', 'Page X'],
    });
  });

  it("given routeType 'page' whose trail has no drive (orphaned page), should resolve with currentDrive null and no drive-name prefix", async () => {
    vi.mocked(canPrincipalViewPage).mockResolvedValue(true);
    vi.mocked(getPageBreadcrumbTrail).mockResolvedValue([
      trailPage({ id: 'page-x', title: 'Orphan Page', drive: null }),
    ]);
    const ref: ContextRef = { routeType: 'page', pageId: 'page-x' };

    expect(await resolveRequestContext(AUTH, ref)).toEqual({
      currentPage: { id: 'page-x', title: 'Orphan Page', type: 'DOCUMENT', path: '/Orphan Page' },
      currentDrive: null,
      breadcrumbs: ['Orphan Page'],
    });
  });

  it("given routeType 'channel' with a viewable pageId, should resolve the same way as 'page'", async () => {
    vi.mocked(canPrincipalViewPage).mockResolvedValue(true);
    vi.mocked(getPageBreadcrumbTrail).mockResolvedValue([trailPage({ drive: null, title: 'General' })]);
    const ref: ContextRef = { routeType: 'channel', pageId: 'page-x' };

    const result = await resolveRequestContext(AUTH, ref);
    expect(result?.currentPage?.title).toBe('General');
  });

  it("given routeType 'drive' with no driveId, should return null", async () => {
    const ref: ContextRef = { routeType: 'drive' };
    expect(await resolveRequestContext(AUTH, ref)).toBeNull();
    expect(isPrincipalDriveMember).not.toHaveBeenCalled();
  });

  it("given routeType 'drive' the caller is NOT a member of, should DENY and return null", async () => {
    vi.mocked(isPrincipalDriveMember).mockResolvedValue(false);
    const ref: ContextRef = { routeType: 'drive', driveId: 'drive-1' };

    expect(await resolveRequestContext(AUTH, ref)).toBeNull();
    expect(isPrincipalDriveMember).toHaveBeenCalledWith(AUTH, 'drive-1');
    expect(dbLimitMock).not.toHaveBeenCalled();
  });

  it("given routeType 'drive' the caller IS a member of but the drive row is gone, should return null", async () => {
    vi.mocked(isPrincipalDriveMember).mockResolvedValue(true);
    dbLimitMock.mockResolvedValue([]);
    const ref: ContextRef = { routeType: 'drive', driveId: 'drive-1' };

    expect(await resolveRequestContext(AUTH, ref)).toBeNull();
  });

  it("given routeType 'drive' the caller IS a member of, should resolve currentDrive with no currentPage", async () => {
    vi.mocked(isPrincipalDriveMember).mockResolvedValue(true);
    dbLimitMock.mockResolvedValue([{ id: 'drive-1', name: 'Engineering', slug: 'engineering' }]);
    const ref: ContextRef = { routeType: 'drive', driveId: 'drive-1' };

    expect(await resolveRequestContext(AUTH, ref)).toEqual({
      currentPage: null,
      currentDrive: { id: 'drive-1', name: 'Engineering', slug: 'engineering' },
      breadcrumbs: ['Engineering'],
    });
  });

  // Audit trail parity: the sibling authz check in the same routes
  // (checkMCPPageScope) reports every denial via auditRequest — a contextRef
  // pointing at something the caller can't view/isn't a member of is the same
  // class of event and must be equally observable (repeated probing should be
  // detectable), even though the resolved value itself stays a silent `null`
  // rather than an error response.
  describe('onAccessDenied callback', () => {
    it("given routeType 'page' the caller CANNOT view, should invoke onAccessDenied with routeType and pageId", async () => {
      vi.mocked(canPrincipalViewPage).mockResolvedValue(false);
      const onAccessDenied = vi.fn();
      const ref: ContextRef = { routeType: 'page', pageId: 'secret-page' };

      await resolveRequestContext(AUTH, ref, onAccessDenied);

      expect(onAccessDenied).toHaveBeenCalledWith({ routeType: 'page', pageId: 'secret-page' });
    });

    it("given routeType 'drive' the caller is NOT a member of, should invoke onAccessDenied with routeType and driveId", async () => {
      vi.mocked(isPrincipalDriveMember).mockResolvedValue(false);
      const onAccessDenied = vi.fn();
      const ref: ContextRef = { routeType: 'drive', driveId: 'drive-1' };

      await resolveRequestContext(AUTH, ref, onAccessDenied);

      expect(onAccessDenied).toHaveBeenCalledWith({ routeType: 'drive', driveId: 'drive-1' });
    });

    it('given a successfully resolved page, should NOT invoke onAccessDenied', async () => {
      vi.mocked(canPrincipalViewPage).mockResolvedValue(true);
      vi.mocked(getPageBreadcrumbTrail).mockResolvedValue([trailPage({})]);
      const onAccessDenied = vi.fn();
      const ref: ContextRef = { routeType: 'page', pageId: 'page-x' };

      await resolveRequestContext(AUTH, ref, onAccessDenied);

      expect(onAccessDenied).not.toHaveBeenCalled();
    });

    it('given a page that passes the view check but no longer exists (empty trail), should NOT invoke onAccessDenied (not a security denial)', async () => {
      vi.mocked(canPrincipalViewPage).mockResolvedValue(true);
      vi.mocked(getPageBreadcrumbTrail).mockResolvedValue([]);
      const onAccessDenied = vi.fn();
      const ref: ContextRef = { routeType: 'page', pageId: 'page-x' };

      await resolveRequestContext(AUTH, ref, onAccessDenied);

      expect(onAccessDenied).not.toHaveBeenCalled();
    });

    it("given no contextRef, should NOT invoke onAccessDenied", async () => {
      const onAccessDenied = vi.fn();
      await resolveRequestContext(AUTH, undefined, onAccessDenied);
      expect(onAccessDenied).not.toHaveBeenCalled();
    });

    it("given routeType 'other', should NOT invoke onAccessDenied", async () => {
      const onAccessDenied = vi.fn();
      await resolveRequestContext(AUTH, { routeType: 'other' }, onAccessDenied);
      expect(onAccessDenied).not.toHaveBeenCalled();
    });

    it('given no callback provided, should not throw on a denied page', async () => {
      vi.mocked(canPrincipalViewPage).mockResolvedValue(false);
      const ref: ContextRef = { routeType: 'page', pageId: 'secret-page' };
      await expect(resolveRequestContext(AUTH, ref)).resolves.toBeNull();
    });
  });
});
