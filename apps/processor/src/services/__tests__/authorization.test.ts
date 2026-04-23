import { beforeEach, describe, expect, it, vi } from 'vitest';

const VALID_HASH = 'a'.repeat(64);

const mockGetLinksForFile = vi.fn();
const mockGetFileDriveId = vi.fn();
const mockGetUserAccessLevel = vi.fn();
const mockGetUserDrivePermissions = vi.fn();

vi.mock('../file-links', () => ({
  getLinksForFile: (...args: unknown[]) => mockGetLinksForFile(...args),
  getFileDriveId: (...args: unknown[]) => mockGetFileDriveId(...args),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
    getUserAccessLevel: (...args: unknown[]) => mockGetUserAccessLevel(...args),
}));
vi.mock('@pagespace/lib/permissions', () => ({
    getUserDrivePermissions: (...args: unknown[]) => mockGetUserDrivePermissions(...args),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    security: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

import type { EnforcedAuthContext } from '../../middleware/auth';
import { authorizeFileAccess, assertFileAccess, FileAuthorizationError } from '../authorization';

function createAuth(overrides: Partial<EnforcedAuthContext> = {}): EnforcedAuthContext {
  return {
    userId: 'user-1',
    userRole: 'user',
    resourceBinding: undefined,
    driveId: undefined,
    hasScope: () => true,
    isAdmin: () => false,
    isBoundToResource: () => !!overrides.resourceBinding,
    ...overrides,
  } as unknown as EnforcedAuthContext;
}

describe('authorizeFileAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetLinksForFile.mockResolvedValue([]);
    mockGetFileDriveId.mockResolvedValue('drive-1');
    mockGetUserAccessLevel.mockResolvedValue(null);
    mockGetUserDrivePermissions.mockResolvedValue(null);
  });

  describe('identity verification', () => {
    it('denies when userId is missing', async () => {
      const auth = createAuth({ userId: '' });
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'view');

      expect(decision.allowed).toBe(false);
      expect(decision.denial?.stage).toBe('identity');
      expect(decision.checks.identityVerified).toBe(false);
    });
  });

  describe('unbound tokens', () => {
    it('allows unbound token when user has view permission', async () => {
      mockGetLinksForFile.mockResolvedValue([
        { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-1' },
      ]);
      mockGetUserAccessLevel.mockResolvedValue({
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
      });

      const auth = createAuth();
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'view');

      expect(decision.allowed).toBe(true);
      expect(decision.binding.matchType).toBe('unbound');
      expect(decision.permission?.grantedVia).toBe('page_permission');
      expect(decision.context?.pageId).toBe('page-1');
    });

    it('allows unbound token when user has edit permission for edit requirement', async () => {
      mockGetLinksForFile.mockResolvedValue([
        { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-1' },
      ]);
      mockGetUserAccessLevel.mockResolvedValue({
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
      });

      const auth = createAuth();
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'edit');

      expect(decision.allowed).toBe(true);
      expect(decision.binding.matchType).toBe('unbound');
      expect(decision.permission?.required).toBe('edit');
    });

    it('denies unbound token when user has no permission', async () => {
      mockGetLinksForFile.mockResolvedValue([
        { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-1' },
      ]);
      mockGetUserAccessLevel.mockResolvedValue(null);

      const auth = createAuth();
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'view');

      expect(decision.allowed).toBe(false);
      expect(decision.denial?.stage).toBe('permission');
    });
  });

  describe('file-bound tokens', () => {
    it('allows file-bound token matching contentHash', async () => {
      mockGetLinksForFile.mockResolvedValue([
        { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-1' },
      ]);
      mockGetUserAccessLevel.mockResolvedValue({
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
      });

      const auth = createAuth({
        resourceBinding: { type: 'file', id: VALID_HASH },
      });
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'view');

      expect(decision.allowed).toBe(true);
      expect(decision.binding.matchType).toBe('exact');
      expect(decision.binding.tokenBinding?.type).toBe('file');
    });

    it('denies file-bound token not matching contentHash', async () => {
      const otherHash = 'b'.repeat(64);

      const auth = createAuth({
        resourceBinding: { type: 'file', id: otherHash },
      });
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'view');

      expect(decision.allowed).toBe(false);
      expect(decision.binding.matchType).toBe('mismatch');
      expect(decision.denial?.stage).toBe('binding');
    });
  });

  describe('page-bound tokens', () => {
    it('allows page-bound token with file linked to bound page', async () => {
      mockGetLinksForFile.mockResolvedValue([
        { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-1' },
      ]);
      mockGetUserAccessLevel.mockResolvedValue({
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
      });

      const auth = createAuth({
        resourceBinding: { type: 'page', id: 'page-1' },
      });
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'view');

      expect(decision.allowed).toBe(true);
      expect(decision.binding.matchType).toBe('hierarchical');
    });

    it('denies page-bound token with file NOT linked to bound page', async () => {
      mockGetLinksForFile.mockResolvedValue([
        { fileId: VALID_HASH, pageId: 'page-2', driveId: 'drive-1' },
      ]);

      const auth = createAuth({
        resourceBinding: { type: 'page', id: 'page-1' },
      });
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'view');

      expect(decision.allowed).toBe(false);
      expect(decision.binding.matchType).toBe('mismatch');
      expect(decision.denial?.stage).toBe('binding');
    });

    it('denies page-bound token when file has no links', async () => {
      mockGetLinksForFile.mockResolvedValue([]);

      const auth = createAuth({
        resourceBinding: { type: 'page', id: 'page-1' },
      });
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'view');

      expect(decision.allowed).toBe(false);
      expect(decision.binding.matchType).toBe('mismatch');
      expect(decision.denial?.stage).toBe('binding');
    });
  });

  describe('drive-bound tokens', () => {
    it('allows drive-bound token with file in bound drive', async () => {
      mockGetLinksForFile.mockResolvedValue([
        { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-1' },
      ]);
      mockGetUserAccessLevel.mockResolvedValue({
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
      });

      const auth = createAuth({
        resourceBinding: { type: 'drive', id: 'drive-1' },
      });
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'view');

      expect(decision.allowed).toBe(true);
      expect(decision.binding.matchType).toBe('hierarchical');
    });

    it('denies drive-bound token with file in other drive', async () => {
      mockGetLinksForFile.mockResolvedValue([
        { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-2' },
      ]);

      const auth = createAuth({
        resourceBinding: { type: 'drive', id: 'drive-1' },
      });
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'view');

      expect(decision.allowed).toBe(false);
      expect(decision.binding.matchType).toBe('mismatch');
      expect(decision.denial?.stage).toBe('binding');
    });

    it('allows drive-bound token for orphan file in bound drive', async () => {
      mockGetLinksForFile.mockResolvedValue([]);
      mockGetFileDriveId.mockResolvedValue('drive-1');
      mockGetUserDrivePermissions.mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isAdmin: false,
        isMember: true,
      });

      const auth = createAuth({
        resourceBinding: { type: 'drive', id: 'drive-1' },
      });
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'view');

      expect(decision.allowed).toBe(true);
      expect(decision.binding.matchType).toBe('hierarchical');
      expect(decision.permission?.grantedVia).toBe('drive_permission');
    });
  });

  describe('orphan files', () => {
    it('allows view for orphan file when user has drive membership', async () => {
      mockGetLinksForFile.mockResolvedValue([]);
      mockGetFileDriveId.mockResolvedValue('drive-1');
      mockGetUserDrivePermissions.mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isAdmin: false,
        isMember: true,
      });

      const auth = createAuth();
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'view');

      expect(decision.allowed).toBe(true);
      expect(decision.permission?.grantedVia).toBe('drive_permission');
    });

    it('allows edit for orphan file when user is drive owner/admin', async () => {
      mockGetLinksForFile.mockResolvedValue([]);
      mockGetFileDriveId.mockResolvedValue('drive-1');
      mockGetUserDrivePermissions.mockResolvedValue({
        hasAccess: true,
        isOwner: true,
        isAdmin: false,
        isMember: true,
      });

      const auth = createAuth();
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'edit');

      expect(decision.allowed).toBe(true);
      expect(decision.permission?.grantedVia).toBe('drive_permission');
    });

    it('denies edit for orphan file when user is only member', async () => {
      mockGetLinksForFile.mockResolvedValue([]);
      mockGetFileDriveId.mockResolvedValue('drive-1');
      mockGetUserDrivePermissions.mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isAdmin: false,
        isMember: true,
      });

      const auth = createAuth();
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'edit');

      expect(decision.allowed).toBe(false);
      expect(decision.denial?.stage).toBe('permission');
    });

    it('denies orphan file with no drive association', async () => {
      mockGetLinksForFile.mockResolvedValue([]);
      mockGetFileDriveId.mockResolvedValue(undefined);

      const auth = createAuth();
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'view');

      expect(decision.allowed).toBe(false);
      expect(decision.denial?.stage).toBe('not_found');
    });
  });

  describe('permission checks', () => {
    it('denies when binding allows but user lacks permission', async () => {
      mockGetLinksForFile.mockResolvedValue([
        { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-1' },
      ]);
      mockGetUserAccessLevel.mockResolvedValue({
        canView: false,
        canEdit: false,
        canShare: false,
        canDelete: false,
      });

      const auth = createAuth({
        resourceBinding: { type: 'page', id: 'page-1' },
      });
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'view');

      expect(decision.allowed).toBe(false);
      expect(decision.denial?.stage).toBe('permission');
      expect(decision.checks.bindingAllowed).toBe(true);
      expect(decision.checks.permissionGranted).toBe(false);
    });

    it('allows edit when user has share permission', async () => {
      mockGetLinksForFile.mockResolvedValue([
        { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-1' },
      ]);
      mockGetUserAccessLevel.mockResolvedValue({
        canView: true,
        canEdit: false,
        canShare: true,
        canDelete: false,
      });

      const auth = createAuth();
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'edit');

      expect(decision.allowed).toBe(true);
    });
  });

  describe('unknown binding types', () => {
    it('denies unknown binding type', async () => {
      const auth = createAuth({
        resourceBinding: { type: 'workspace', id: 'workspace-1' },
      });
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'view');

      expect(decision.allowed).toBe(false);
      expect(decision.binding.matchType).toBe('mismatch');
      expect(decision.denial?.stage).toBe('binding');
    });
  });

  describe('checkDrivePermissions returns false when drivePerms is null', () => {
    it('denies view for orphan file when getUserDrivePermissions returns null', async () => {
      mockGetLinksForFile.mockResolvedValue([]);
      mockGetFileDriveId.mockResolvedValue('drive-1');
      // drivePerms is null -> checkDrivePermissions returns false -> permission denied
      mockGetUserDrivePermissions.mockResolvedValue(null);

      const auth = createAuth();
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'view');

      expect(decision.allowed).toBe(false);
      expect(decision.denial?.stage).toBe('permission');
    });

    it('denies view for drive-bound orphan when getUserDrivePermissions returns null', async () => {
      mockGetLinksForFile.mockResolvedValue([]);
      mockGetFileDriveId.mockResolvedValue('drive-1');
      mockGetUserDrivePermissions.mockResolvedValue(null);

      const auth = createAuth({
        resourceBinding: { type: 'drive', id: 'drive-1' },
      });
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'view');

      expect(decision.allowed).toBe(false);
      expect(decision.denial?.stage).toBe('permission');
    });
  });

  describe('scopedLinks is empty when file has links but none in scope', () => {
    it('denies page-bound token when file has links but none match the bound page', async () => {
      // File has links to page-2 and page-3, but token is bound to page-1
      mockGetLinksForFile.mockResolvedValue([
        { fileId: VALID_HASH, pageId: 'page-2', driveId: 'drive-1' },
        { fileId: VALID_HASH, pageId: 'page-3', driveId: 'drive-2' },
      ]);

      const auth = createAuth({
        resourceBinding: { type: 'page', id: 'page-1' },
      });
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'view');

      // binding type is 'page', links don't include page-1 so matchType='mismatch'
      // mismatch is caught at step 3 (binding check), not step 5 (scoped links)
      expect(decision.allowed).toBe(false);
      expect(decision.denial?.stage).toBe('binding');
    });

    it('denies drive-bound token when file has links but none match the bound drive (scopedLinks empty)', async () => {
      // File has links but to drive-2 only; token is bound to drive-1
      // determineBindingMatchType for drive-binding checks links.some(l => l.driveId === 'drive-1')
      // That returns false, so matchType = 'mismatch', caught at step 3
      mockGetLinksForFile.mockResolvedValue([
        { fileId: VALID_HASH, pageId: 'page-2', driveId: 'drive-2' },
      ]);

      const auth = createAuth({
        resourceBinding: { type: 'drive', id: 'drive-1' },
      });
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'view');

      expect(decision.allowed).toBe(false);
      expect(decision.denial?.stage).toBe('binding');
    });

    it('denies file-bound token when scopedLinks exists but page permissions fail (covers scoped path with file binding)', async () => {
      // File binding: getScopedLinks returns all links, then page permissions checked
      // Here permissions fail so we reach the permission denial
      mockGetLinksForFile.mockResolvedValue([
        { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-1' },
      ]);
      mockGetUserAccessLevel.mockResolvedValue({
        canView: false,
        canEdit: false,
        canShare: false,
        canDelete: false,
      });

      const auth = createAuth({
        resourceBinding: { type: 'file', id: VALID_HASH },
      });
      const decision = await authorizeFileAccess(auth, VALID_HASH, 'view');

      expect(decision.allowed).toBe(false);
      expect(decision.denial?.stage).toBe('permission');
      expect(decision.binding.matchType).toBe('exact');
    });
  });
});

describe('assertFileAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetLinksForFile.mockResolvedValue([
      { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-1' },
    ]);
    mockGetFileDriveId.mockResolvedValue('drive-1');
    mockGetUserAccessLevel.mockResolvedValue({
      canView: true,
      canEdit: true,
      canShare: false,
      canDelete: false,
    });
  });

  it('returns decision when access is allowed', async () => {
    const auth = createAuth();
    const decision = await assertFileAccess(auth, VALID_HASH, 'view');

    expect(decision.allowed).toBe(true);
  });

  it('throws FileAuthorizationError when access is denied', async () => {
    mockGetUserAccessLevel.mockResolvedValue(null);

    const auth = createAuth();

    await expect(assertFileAccess(auth, VALID_HASH, 'view')).rejects.toBeInstanceOf(
      FileAuthorizationError
    );
  });

  it('includes decision in thrown error', async () => {
    mockGetUserAccessLevel.mockResolvedValue(null);

    const auth = createAuth();

    try {
      await assertFileAccess(auth, VALID_HASH, 'view');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FileAuthorizationError);
      const authError = error as FileAuthorizationError;
      expect(authError.decision?.allowed).toBe(false);
      expect(authError.decision?.denial?.stage).toBe('permission');
    }
  });
});
