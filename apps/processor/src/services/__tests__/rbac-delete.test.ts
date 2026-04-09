import { beforeEach, describe, expect, it, vi } from 'vitest';

const VALID_HASH = 'a'.repeat(64);

const mockGetLinksForFile = vi.fn();
const mockGetUserAccessLevel = vi.fn();
const mockGetUserDrivePermissions = vi.fn();
const mockFilesFindFirst = vi.fn();
const mockFilePagesFindFirst = vi.fn();
const mockChannelMessagesFindFirst = vi.fn();
const mockPagesFindFirst = vi.fn();

vi.mock('../file-links', () => ({
  getLinksForFile: (...args: unknown[]) => mockGetLinksForFile(...args),
}));

vi.mock('@pagespace/lib/permissions-cached', () => ({
  getUserAccessLevel: (...args: unknown[]) => mockGetUserAccessLevel(...args),
  getUserDrivePermissions: (...args: unknown[]) => mockGetUserDrivePermissions(...args),
}));

vi.mock('@pagespace/lib/logger-config', () => ({
  loggers: {
    security: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  },
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      files: {
        findFirst: (...args: unknown[]) => mockFilesFindFirst(...args),
      },
      filePages: {
        findFirst: (...args: unknown[]) => mockFilePagesFindFirst(...args),
      },
      channelMessages: {
        findFirst: (...args: unknown[]) => mockChannelMessagesFindFirst(...args),
      },
      pages: {
        findFirst: (...args: unknown[]) => mockPagesFindFirst(...args),
      },
    },
  },
  files: { id: 'files.id' },
  filePages: { fileId: 'filePages.fileId' },
  channelMessages: { fileId: 'channelMessages.fileId' },
  pages: { filePath: 'pages.filePath' },
  eq: vi.fn((field: string, value: string) => ({ field, value, op: 'eq' })),
}));

import type { EnforcedAuthContext } from '../../middleware/auth';
import {
  assertDeleteFileAccess,
  DeleteFileAuthorizationError,
  DeleteFileReferencedError,
} from '../rbac';

function createAuth(overrides: Partial<EnforcedAuthContext> = {}): EnforcedAuthContext {
  return {
    userId: 'user-1',
    userRole: 'user',
    resourceBinding: undefined,
    driveId: undefined,
    hasScope: () => true,
    isAdmin: () => false,
    isBoundToResource: () => true,
    ...overrides,
  } as unknown as EnforcedAuthContext;
}

describe('assertDeleteFileAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetLinksForFile.mockResolvedValue([]);
    mockFilesFindFirst.mockResolvedValue({ driveId: 'drive-1' });
    mockFilePagesFindFirst.mockResolvedValue(undefined);
    mockChannelMessagesFindFirst.mockResolvedValue(undefined);
    mockPagesFindFirst.mockResolvedValue(undefined);
    mockGetUserAccessLevel.mockResolvedValue(null);
    mockGetUserDrivePermissions.mockResolvedValue({
      hasAccess: true,
      isOwner: true,
      isAdmin: false,
      isMember: true,
      canEdit: true,
    });
  });

  it('denies when auth is undefined', async () => {
    await expect(assertDeleteFileAccess(undefined, VALID_HASH)).rejects.toBeInstanceOf(DeleteFileAuthorizationError);
  });

  it('allows page-bound token when resource binding matches and page delete permission is granted', async () => {
    mockGetLinksForFile.mockResolvedValue([
      { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-1' },
    ]);
    mockGetUserAccessLevel.mockResolvedValue({
      canView: true,
      canEdit: true,
      canShare: true,
      canDelete: true,
    });

    const auth = createAuth({
      resourceBinding: { type: 'page', id: 'page-1' },
    });

    await expect(assertDeleteFileAccess(auth, VALID_HASH)).resolves.toBeUndefined();
  });

  it('denies page-bound token when binding mismatches linked page', async () => {
    mockGetLinksForFile.mockResolvedValue([
      { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-1' },
    ]);

    const auth = createAuth({
      resourceBinding: { type: 'page', id: 'page-2' },
    });

    await expect(assertDeleteFileAccess(auth, VALID_HASH)).rejects.toBeInstanceOf(DeleteFileAuthorizationError);
  });

  it('allows drive-bound orphan in matching drive for owner/admin', async () => {
    const auth = createAuth({
      resourceBinding: { type: 'drive', id: 'drive-1' },
    });

    await expect(assertDeleteFileAccess(auth, VALID_HASH)).resolves.toBeUndefined();
  });

  it('denies drive-bound orphan when drive does not match token binding', async () => {
    const auth = createAuth({
      resourceBinding: { type: 'drive', id: 'drive-2' },
    });

    await expect(assertDeleteFileAccess(auth, VALID_HASH)).rejects.toBeInstanceOf(DeleteFileAuthorizationError);
  });

  it('denies linked file when user has only edit/share but no delete', async () => {
    mockGetLinksForFile.mockResolvedValue([
      { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-1' },
    ]);
    mockGetUserAccessLevel.mockResolvedValue({
      canView: true,
      canEdit: true,
      canShare: true,
      canDelete: false,
    });

    const auth = createAuth();

    await expect(assertDeleteFileAccess(auth, VALID_HASH)).rejects.toBeInstanceOf(DeleteFileAuthorizationError);
  });

  it('denies unknown token resource binding type', async () => {
    const auth = createAuth({
      resourceBinding: { type: 'workspace', id: 'workspace-1' },
    });

    await expect(assertDeleteFileAccess(auth, VALID_HASH)).rejects.toBeInstanceOf(DeleteFileAuthorizationError);
  });

  it('rejects linked file even when page-bound token can delete because file is not orphaned', async () => {
    mockGetLinksForFile.mockResolvedValue([
      { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-1' },
    ]);
    mockFilePagesFindFirst.mockResolvedValue({ fileId: VALID_HASH });
    mockGetUserAccessLevel.mockResolvedValue({
      canView: true,
      canEdit: true,
      canShare: true,
      canDelete: true,
    });

    const auth = createAuth({
      resourceBinding: { type: 'page', id: 'page-1' },
    });

    await expect(assertDeleteFileAccess(auth, VALID_HASH)).rejects.toBeInstanceOf(DeleteFileReferencedError);
  });

  it('denies orphan file when drivePerms is null (lines 148-155)', async () => {
    // No links, file has a drive, but getUserDrivePermissions returns null
    mockGetLinksForFile.mockResolvedValue([]);
    mockFilesFindFirst.mockResolvedValue({ driveId: 'drive-1' });
    mockGetUserDrivePermissions.mockResolvedValue(null);

    const auth = createAuth();

    await expect(assertDeleteFileAccess(auth, VALID_HASH)).rejects.toBeInstanceOf(DeleteFileAuthorizationError);
  });

  it('denies orphan file when user has drive access but is not owner or admin (lines 148-155)', async () => {
    mockGetLinksForFile.mockResolvedValue([]);
    mockFilesFindFirst.mockResolvedValue({ driveId: 'drive-1' });
    mockGetUserDrivePermissions.mockResolvedValue({
      hasAccess: true,
      isOwner: false,
      isAdmin: false,
      isMember: true,
    });

    const auth = createAuth();

    await expect(assertDeleteFileAccess(auth, VALID_HASH)).rejects.toBeInstanceOf(DeleteFileAuthorizationError);
  });

  it('allows file-bound token matching the contentHash with linked page delete permission (lines 39-50)', async () => {
    mockGetLinksForFile.mockResolvedValue([
      { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-1' },
    ]);
    mockGetUserAccessLevel.mockResolvedValue({
      canView: true,
      canEdit: true,
      canShare: true,
      canDelete: true,
    });

    const auth = createAuth({
      resourceBinding: { type: 'file', id: VALID_HASH },
    });

    await expect(assertDeleteFileAccess(auth, VALID_HASH)).resolves.toBeUndefined();
  });

  it('denies file-bound token not matching the contentHash (lines 39-50)', async () => {
    mockGetLinksForFile.mockResolvedValue([
      { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-1' },
    ]);

    const auth = createAuth({
      resourceBinding: { type: 'file', id: 'b'.repeat(64) },
    });

    await expect(assertDeleteFileAccess(auth, VALID_HASH)).rejects.toBeInstanceOf(DeleteFileAuthorizationError);
  });

  it('allows drive-bound token when file links include the bound drive and user has delete permission (lines 39-50)', async () => {
    mockGetLinksForFile.mockResolvedValue([
      { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-1' },
    ]);
    mockGetUserAccessLevel.mockResolvedValue({
      canView: true,
      canEdit: true,
      canShare: true,
      canDelete: true,
    });

    const auth = createAuth({
      resourceBinding: { type: 'drive', id: 'drive-1' },
    });

    await expect(assertDeleteFileAccess(auth, VALID_HASH)).resolves.toBeUndefined();
  });

  it('getScopedLinks returns empty array for drive binding when links have different driveId (lines 52-67)', async () => {
    // Drive binding to drive-1, but links are to drive-2 -> binding mismatch at isResourceBindingAllowed
    mockGetLinksForFile.mockResolvedValue([
      { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-2' },
    ]);

    const auth = createAuth({
      resourceBinding: { type: 'drive', id: 'drive-1' },
    });

    await expect(assertDeleteFileAccess(auth, VALID_HASH)).rejects.toBeInstanceOf(DeleteFileAuthorizationError);
  });

  it('denies when orphan file has no drive association (lines 138-144)', async () => {
    // No links, file has no driveId
    mockGetLinksForFile.mockResolvedValue([]);
    mockFilesFindFirst.mockResolvedValue(undefined);

    const auth = createAuth();

    await expect(assertDeleteFileAccess(auth, VALID_HASH)).rejects.toBeInstanceOf(DeleteFileAuthorizationError);
  });

  it('rejects with DeleteFileReferencedError when only channelMessages references exist (lines 158-167)', async () => {
    mockGetLinksForFile.mockResolvedValue([
      { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-1' },
    ]);
    mockGetUserAccessLevel.mockResolvedValue({
      canView: true,
      canEdit: true,
      canShare: true,
      canDelete: true,
    });
    mockChannelMessagesFindFirst.mockResolvedValue({ id: 'msg-1' });

    const auth = createAuth();

    await expect(assertDeleteFileAccess(auth, VALID_HASH)).rejects.toBeInstanceOf(DeleteFileReferencedError);
  });

  it('rejects with DeleteFileReferencedError when only pagePathReferences exist (lines 158-167)', async () => {
    mockGetLinksForFile.mockResolvedValue([
      { fileId: VALID_HASH, pageId: 'page-1', driveId: 'drive-1' },
    ]);
    mockGetUserAccessLevel.mockResolvedValue({
      canView: true,
      canEdit: true,
      canShare: true,
      canDelete: true,
    });
    mockPagesFindFirst.mockResolvedValue({ id: 'page-path-1' });

    const auth = createAuth();

    await expect(assertDeleteFileAccess(auth, VALID_HASH)).rejects.toBeInstanceOf(DeleteFileReferencedError);
  });
});
