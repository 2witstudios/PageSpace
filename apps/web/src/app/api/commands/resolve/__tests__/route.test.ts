import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      commands: { findMany: vi.fn() },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  inArray: vi.fn((field: unknown, values: unknown) => ({ field, values })),
}));
vi.mock('@pagespace/db/schema/commands', () => ({
  commands: { id: 'id' },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn(),
  isUserDriveMember: vi.fn(),
}));
vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn(
    (result: unknown) => !!result && typeof result === 'object' && 'error' in (result as object)
  ),
}));

import { GET } from '../route';
import { db } from '@pagespace/db/db';
import { canUserViewPage, isUserDriveMember } from '@pagespace/lib/permissions/permissions';
import type { SessionAuthResult, AuthError } from '@/lib/auth/auth-types';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';

const mockedAuth = vi.mocked(authenticateRequestWithOptions);
const mockedFindMany = db.query.commands.findMany as unknown as ReturnType<typeof vi.fn>;
const mockedCanView = vi.mocked(canUserViewPage);
const mockedIsMember = vi.mocked(isUserDriveMember);

const USER_ID = 'user_1';
const CMD_ID = 'tz4a98xxat96iws9zmbrgj3a';
const DRIVE_ID = 'drv9zmbrgj3atz4a98xxat96';
const ENTRY_PAGE_ID = 'pge9zmbrgj3atz4a98xxat96';

const webAuth = (userId = USER_ID): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess_1',
  role: 'user',
  adminRoleVersion: 0,
});

const authError = (): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
});

const getRequest = (ids: string) =>
  new Request(`http://localhost/api/commands/resolve?ids=${encodeURIComponent(ids)}`);

function commandRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CMD_ID,
    userId: USER_ID,
    driveId: null,
    trigger: 'release-checklist',
    description: 'Run the release checklist.',
    entryPageId: ENTRY_PAGE_ID,
    enabled: true,
    entryPage: { id: ENTRY_PAGE_ID, isTrashed: false },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedAuth.mockResolvedValue(webAuth());
  mockedFindMany.mockResolvedValue([]);
  mockedCanView.mockResolvedValue(true);
  mockedIsMember.mockResolvedValue(true);
});

describe('GET /api/commands/resolve', () => {
  it('requires authentication', async () => {
    mockedAuth.mockResolvedValue(authError());
    const response = await GET(getRequest(CMD_ID));
    expect(response.status).toBe(401);
  });

  it('rejects a missing/empty ids param', async () => {
    const response = await GET(getRequest(''));
    expect(response.status).toBe(400);
  });

  it('rejects more than 50 ids', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `aaaaaaaaaaaaaaaaaaaaaa${String(i).padStart(2, '0')}`);
    const response = await GET(getRequest(ids.join(',')));
    expect(response.status).toBe(400);
  });

  it('returns deleted for an unknown command id', async () => {
    const response = await GET(getRequest(CMD_ID));
    const body = await response.json();
    expect(body.results[CMD_ID]).toEqual({ state: 'deleted' });
  });

  it('marks malformed ids deleted without letting them reach the DB query', async () => {
    const evil = 'id;DROP TABLE';
    const response = await GET(getRequest(`${evil},${CMD_ID}`));
    const body = await response.json();
    expect(body.results[evil]).toEqual({ state: 'deleted' });
    expect(mockedFindMany).toHaveBeenCalledTimes(1);
    const where = mockedFindMany.mock.calls[0][0].where as { values: string[] };
    expect(where.values).toEqual([CMD_ID]);
  });

  it("resolves the viewer's own personal command fully", async () => {
    mockedFindMany.mockResolvedValue([commandRow()]);
    const response = await GET(getRequest(CMD_ID));
    const body = await response.json();
    expect(body.results[CMD_ID]).toEqual({
      state: 'ok',
      trigger: 'release-checklist',
      description: 'Run the release checklist.',
      scope: 'user',
      enabled: true,
      entryPageId: ENTRY_PAGE_ID,
      entryPageTrashed: false,
      viewerCanViewEntryPage: true,
    });
  });

  it("returns restricted for another user's personal command (no metadata leak)", async () => {
    mockedFindMany.mockResolvedValue([commandRow({ userId: 'someone_else' })]);
    const response = await GET(getRequest(CMD_ID));
    const body = await response.json();
    expect(body.results[CMD_ID]).toEqual({ state: 'restricted' });
  });

  it('resolves a drive command fully for members and restricted for non-members', async () => {
    mockedFindMany.mockResolvedValue([commandRow({ userId: null, driveId: DRIVE_ID })]);

    mockedIsMember.mockResolvedValue(true);
    let body = await (await GET(getRequest(CMD_ID))).json();
    expect(body.results[CMD_ID]).toMatchObject({ state: 'ok', scope: 'drive' });

    mockedIsMember.mockResolvedValue(false);
    body = await (await GET(getRequest(CMD_ID))).json();
    expect(body.results[CMD_ID]).toEqual({ state: 'restricted' });
  });

  it('reports a trashed entry page without checking page access', async () => {
    mockedFindMany.mockResolvedValue([
      commandRow({ entryPage: { id: ENTRY_PAGE_ID, isTrashed: true } }),
    ]);
    const response = await GET(getRequest(CMD_ID));
    const body = await response.json();
    expect(body.results[CMD_ID]).toMatchObject({
      state: 'ok',
      entryPageTrashed: true,
      viewerCanViewEntryPage: false,
    });
    expect(mockedCanView).not.toHaveBeenCalled();
  });

  it('reports viewerCanViewEntryPage false when page access is revoked', async () => {
    mockedCanView.mockResolvedValue(false);
    mockedFindMany.mockResolvedValue([commandRow()]);
    const response = await GET(getRequest(CMD_ID));
    const body = await response.json();
    expect(body.results[CMD_ID]).toMatchObject({
      state: 'ok',
      viewerCanViewEntryPage: false,
    });
  });

  it('resolves built-in ids from the registry without touching the DB', async () => {
    const response = await GET(getRequest('builtin:help'));
    const body = await response.json();
    expect(body.results['builtin:help']).toMatchObject({
      state: 'ok',
      trigger: 'help',
      scope: 'builtin',
      enabled: true,
    });
    expect(mockedFindMany).not.toHaveBeenCalled();
  });

  it('returns deleted for an unknown built-in id', async () => {
    const response = await GET(getRequest('builtin:nope'));
    const body = await response.json();
    expect(body.results['builtin:nope']).toEqual({ state: 'deleted' });
  });
});
