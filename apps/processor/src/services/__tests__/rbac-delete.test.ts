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
});
