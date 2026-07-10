/**
 * Universal Commands phase 6 — edge cases for the batch chip-resolution
 * endpoint (GET /api/commands/resolve). The endpoint feeds transcript chip
 * rendering (UX spec §5), so every degraded state must come back as a clean
 * resolution object — a 500 here breaks every transcript that ever used a
 * command. Ids arrive from message content and are fully client-controlled.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
import type { SessionAuthResult } from '@/lib/auth/auth-types';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';

const mockedAuth = vi.mocked(authenticateRequestWithOptions);
const mockedFindMany = db.query.commands.findMany as unknown as ReturnType<typeof vi.fn>;
const mockedCanView = vi.mocked(canUserViewPage);
const mockedIsMember = vi.mocked(isUserDriveMember);

const USER_ID = 'user_1';
const CMD_ID = 'tz4a98xxat96iws9zmbrgj3a';
const DRIVE_ID = 'drv9zmbrgj3atz4a98xxat96';
const ENTRY_PAGE_ID = 'pge9zmbrgj3atz4a98xxat96';

const webAuth = (): SessionAuthResult => ({
  userId: USER_ID,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess_1',
  role: 'user',
  adminRoleVersion: 0,
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

describe('GET /api/commands/resolve — forged and hostile ids', () => {
  const hostileIds = ['../../etc', '<script>alert(1)</script>', 'builtin:nonexistent'];

  it.each(hostileIds)('resolves %s as deleted with a 200, never a 500', async (id) => {
    const response = await GET(getRequest(id));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results[id]).toEqual({ state: 'deleted' });
  });

  it('keeps hostile ids out of the DB query entirely', async () => {
    const response = await GET(getRequest(hostileIds.join(',')));
    expect(response.status).toBe(200);
    expect(mockedFindMany).not.toHaveBeenCalled();
  });

  it('resolves a 64k-character id as deleted without erroring', async () => {
    const huge = 'a'.repeat(64 * 1024);
    const response = await GET(getRequest(huge));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results[huge]).toEqual({ state: 'deleted' });
    expect(mockedFindMany).not.toHaveBeenCalled();
  });

  it('resolves a mixed batch: hostile ids degrade individually, valid ids still resolve', async () => {
    mockedFindMany.mockResolvedValue([commandRow()]);
    const response = await GET(getRequest(`../../etc,${CMD_ID},builtin:help`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results['../../etc']).toEqual({ state: 'deleted' });
    expect(body.results[CMD_ID]).toMatchObject({ state: 'ok', trigger: 'release-checklist' });
    expect(body.results['builtin:help']).toMatchObject({ state: 'ok', scope: 'builtin' });
  });

  it('deduplicates repeated ids instead of double-querying', async () => {
    mockedFindMany.mockResolvedValue([commandRow()]);
    const response = await GET(getRequest(`${CMD_ID},${CMD_ID},${CMD_ID}`));
    expect(response.status).toBe(200);
    const where = mockedFindMany.mock.calls[0][0].where as { values: string[] };
    expect(where.values).toEqual([CMD_ID]);
  });
});

describe('GET /api/commands/resolve — lifecycle transitions', () => {
  it('returns current trigger/description after a rename; the stale chip label is the client’s concern', async () => {
    mockedFindMany.mockResolvedValue([
      commandRow({ trigger: 'release-checklist-v2', description: 'Updated description.' }),
    ]);
    const response = await GET(getRequest(CMD_ID));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results[CMD_ID]).toMatchObject({
      state: 'ok',
      trigger: 'release-checklist-v2',
      description: 'Updated description.',
    });
  });

  it('reports entryPageTrashed when the entry page relation is missing (hard-delete race window)', async () => {
    // The pages FK is onDelete cascade, so normally the command row vanishes
    // with the page — but a read raced against the delete must still degrade.
    mockedFindMany.mockResolvedValue([commandRow({ entryPage: null })]);
    const response = await GET(getRequest(CMD_ID));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results[CMD_ID]).toMatchObject({
      state: 'ok',
      entryPageTrashed: true,
      viewerCanViewEntryPage: false,
    });
    expect(mockedCanView).not.toHaveBeenCalled();
  });

  it('resolves deleted after the command row is gone (entry page hard-deleted → FK cascade)', async () => {
    mockedFindMany.mockResolvedValue([]);
    const response = await GET(getRequest(CMD_ID));
    const body = await response.json();
    expect(body.results[CMD_ID]).toEqual({ state: 'deleted' });
  });

  it('resolves restricted for a drive command after the viewer left (or was removed from) the drive', async () => {
    mockedFindMany.mockResolvedValue([commandRow({ userId: null, driveId: DRIVE_ID })]);
    mockedIsMember.mockResolvedValue(false);
    const response = await GET(getRequest(CMD_ID));
    const body = await response.json();
    expect(body.results[CMD_ID]).toEqual({ state: 'restricted' });
  });

  it('resolves deleted once a drive deletion cascade removed the command row', async () => {
    // drive deleted → commands.driveId cascade → row gone. Old transcripts in
    // (still-shared) channels must show the removed treatment, not an error.
    mockedFindMany.mockResolvedValue([]);
    const response = await GET(getRequest(CMD_ID));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results[CMD_ID]).toEqual({ state: 'deleted' });
  });

  it('returns enabled:false for a command disabled mid-conversation (chip renders, new executions skip)', async () => {
    mockedFindMany.mockResolvedValue([commandRow({ enabled: false })]);
    const response = await GET(getRequest(CMD_ID));
    const body = await response.json();
    expect(body.results[CMD_ID]).toMatchObject({ state: 'ok', enabled: false });
  });

  it('leaks no metadata through restricted resolutions', async () => {
    mockedFindMany.mockResolvedValue([
      commandRow({ userId: 'someone_else', description: 'SECRET internal process' }),
    ]);
    const response = await GET(getRequest(CMD_ID));
    const raw = JSON.stringify(await response.json());
    expect(raw).not.toContain('SECRET internal process');
    expect(raw).not.toContain('release-checklist');
    expect(raw).not.toContain(ENTRY_PAGE_ID);
  });
});
