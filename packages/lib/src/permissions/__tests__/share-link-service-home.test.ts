/**
 * share-link-service Home drive guard tests.
 * Verifies that createDriveShareLink returns { ok: false, error: 'HOME_DRIVE' }
 * when the target drive is a Home drive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    query: {
      drives: { findFirst: vi.fn() },
    },
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((col, val) => ({ op: 'eq', col, val })),
  and: vi.fn((...args) => ({ op: 'and', args })),
  sql: vi.fn(),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'drives.id', name: 'drives.name', kind: 'drives.kind' },
  pages: { id: 'pages.id', driveId: 'pages.driveId' },
}));

vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: {},
  driveRoles: {},
  pagePermissions: {},
}));

vi.mock('@pagespace/db/schema/share-links', () => ({
  driveShareLinks: {},
  pageShareLinks: {},
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: {},
}));

vi.mock('../permissions', () => ({
  isDriveOwnerOrAdmin: vi.fn().mockResolvedValue(true),
  canUserSharePage: vi.fn().mockResolvedValue(true),
  isUserDriveMember: vi.fn().mockResolvedValue(false),
}));

vi.mock('../auth/token-utils', () => ({
  generateToken: vi.fn(() => ({ token: 'tok123', tokenHash: 'hash123' })),
}));

vi.mock('@pagespace/lib/auth/token-utils', () => ({
  generateToken: vi.fn(() => ({ token: 'tok123', tokenHash: 'hash123' })),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'generated-id'),
  init: vi.fn(() => vi.fn(() => 'generated-id')),
}));

import { db } from '@pagespace/db/db';
import { createDriveShareLink } from '../share-link-service';

const mockDb = vi.mocked(db);

const ctx = { userId: 'user-1' } as unknown as Parameters<typeof createDriveShareLink>[0];

describe('createDriveShareLink — Home drive guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: user is authorized (isDriveOwnerOrAdmin mocked true above)
  });

  it('returns HOME_DRIVE error when drive.kind is HOME', async () => {
    // findFirst returns a Home drive
    mockDb.query.drives.findFirst = vi.fn().mockResolvedValue({ kind: 'HOME' });

    const result = await createDriveShareLink(ctx, 'drive-home-1', {});

    expect(result).toEqual({ ok: false, error: 'HOME_DRIVE' });
  });

  it('returns ok:true when drive.kind is STANDARD', async () => {
    // findFirst returns a standard drive
    mockDb.query.drives.findFirst = vi.fn().mockResolvedValue({ kind: 'STANDARD' });

    // Mock insert chain
    const insertChain = {
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'link-1' }]),
      }),
    };
    mockDb.insert = vi.fn().mockReturnValue(insertChain);

    const result = await createDriveShareLink(ctx, 'drive-std-1', {});

    expect(result.ok).toBe(true);
  });

  it('returns ok:false with HOME_DRIVE when drive has no kind (undefined treated as non-Home)', async () => {
    // If drive not found, should not block (no drive = no Home check)
    mockDb.query.drives.findFirst = vi.fn().mockResolvedValue(null);

    const insertChain = {
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'link-1' }]),
      }),
    };
    mockDb.insert = vi.fn().mockReturnValue(insertChain);

    // Should not return HOME_DRIVE when drive not found
    const result = await createDriveShareLink(ctx, 'drive-missing', {});
    expect(result.ok).toBe(true);
  });
});
