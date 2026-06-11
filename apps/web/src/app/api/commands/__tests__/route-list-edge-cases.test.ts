/**
 * Universal Commands phase 6 — settings-list degradation paths for
 * GET /api/commands (UX spec §3.1). The settings rows render the
 * "Entry page unavailable" badge from `entryPageAvailable`, so each
 * degraded entry-page state must surface as available:false (and never a
 * 500), and inaccessible page metadata must be suppressed, not leaked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      commands: { findFirst: vi.fn(), findMany: vi.fn() },
      pages: { findFirst: vi.fn(), findMany: vi.fn() },
      users: { findMany: vi.fn() },
    },
    select: vi.fn(),
    insert: vi.fn(),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  inArray: vi.fn((field: unknown, values: unknown) => ({ field, values })),
  isNotNull: vi.fn((field: unknown) => ({ isNotNull: field })),
}));
vi.mock('@pagespace/db/schema/commands', () => ({
  commands: { id: 'id', userId: 'userId', driveId: 'driveId', trigger: 'trigger', enabled: 'enabled' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'id', ownerId: 'ownerId', isTrashed: 'isTrashed' },
  pages: { id: 'id', driveId: 'driveId', isTrashed: 'isTrashed' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: { driveId: 'driveId', userId: 'userId', acceptedAt: 'acceptedAt' },
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', name: 'name' },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn(),
  isDriveOwnerOrAdmin: vi.fn(),
  isUserDriveMember: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(
    (result: unknown) => !!result && typeof result === 'object' && 'error' in (result as object)
  ),
}));

import { GET } from '../route';
import { db } from '@pagespace/db/db';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { authenticateRequestWithOptions } from '@/lib/auth';

const mockedAuth = vi.mocked(authenticateRequestWithOptions);
const mockedDb = vi.mocked(db, true);
const mockedCanView = vi.mocked(canUserViewPage);

const USER_ID = 'user_1';
const ENTRY_PAGE_ID = 'pge9zmbrgj3atz4a98xxat96';

const webAuth = (): SessionAuthResult => ({
  userId: USER_ID,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess_1',
  role: 'user',
  adminRoleVersion: 0,
});

const selectChain = (rows: unknown[]) => ({
  from: vi.fn(() => ({
    where: vi.fn().mockResolvedValue(rows),
    innerJoin: vi.fn(() => ({ where: vi.fn().mockResolvedValue(rows) })),
  })),
});

const getRequest = () => new Request('http://localhost/api/commands');

const storedCommand = {
  id: 'cmd_1',
  userId: USER_ID,
  driveId: null,
  createdById: USER_ID,
  trigger: 'release-checklist',
  description: 'Run the release checklist.',
  entryPageId: ENTRY_PAGE_ID,
  type: 'document',
  enabled: true,
  createdAt: new Date('2026-06-09T00:00:00Z'),
  updatedAt: new Date('2026-06-09T00:00:00Z'),
};

const entryPage = {
  id: ENTRY_PAGE_ID,
  title: 'Release Checklist',
  driveId: 'drive_1',
  isTrashed: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedAuth.mockResolvedValue(webAuth());
  mockedDb.query.commands.findMany.mockResolvedValue([storedCommand] as never);
  mockedDb.query.pages.findMany.mockResolvedValue([entryPage] as never);
  mockedDb.query.users.findMany.mockResolvedValue([] as never);
  mockedCanView.mockResolvedValue(true);
  mockedDb.select
    .mockReturnValueOnce(selectChain([]) as never)
    .mockReturnValueOnce(selectChain([]) as never);
});

describe('GET /api/commands — entry page degradation in the settings list', () => {
  it('marks the row unavailable when the entry page was trashed after creation (badge data)', async () => {
    mockedDb.query.pages.findMany.mockResolvedValue([
      { ...entryPage, isTrashed: true },
    ] as never);

    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.commands).toHaveLength(1);
    expect(body.commands[0]).toMatchObject({
      id: 'cmd_1',
      entryPageAvailable: false,
    });
  });

  it('survives a hard-deleted entry page race (page row missing) with available:false and no 500', async () => {
    // FK cascade normally removes the command row with the page; in the race
    // window the list may still read the command. It must not crash on the
    // missing page row.
    mockedDb.query.pages.findMany.mockResolvedValue([] as never);

    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.commands[0]).toMatchObject({
      entryPageTitle: null,
      entryPageDriveId: null,
      entryPageAvailable: false,
    });
  });

  it('suppresses the entry page title and drive when the caller lost access (no metadata leak)', async () => {
    mockedCanView.mockResolvedValue(false);

    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.commands[0]).toMatchObject({
      entryPageTitle: null,
      entryPageDriveId: null,
      entryPageAvailable: false,
    });
    expect(JSON.stringify(body)).not.toContain('Release Checklist');
  });

  it('keeps healthy rows available while a degraded sibling row shows the badge', async () => {
    const otherPage = {
      id: 'pgeother9zmbrgj3atz4a98x',
      title: 'Healthy Page',
      driveId: 'drive_1',
      isTrashed: false,
    };
    mockedDb.query.commands.findMany.mockResolvedValue([
      storedCommand,
      { ...storedCommand, id: 'cmd_2', trigger: 'zz-healthy', entryPageId: otherPage.id },
    ] as never);
    mockedDb.query.pages.findMany.mockResolvedValue([
      { ...entryPage, isTrashed: true },
      otherPage,
    ] as never);

    const response = await GET(getRequest());
    const body = await response.json();
    const byId = new Map(
      (body.commands as Array<{ id: string; entryPageAvailable: boolean }>).map((c) => [c.id, c])
    );
    expect(byId.get('cmd_1')).toMatchObject({ entryPageAvailable: false });
    expect(byId.get('cmd_2')).toMatchObject({
      entryPageAvailable: true,
      entryPageTitle: 'Healthy Page',
    });
  });
});
