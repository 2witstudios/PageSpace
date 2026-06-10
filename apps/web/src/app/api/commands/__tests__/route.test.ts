import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      commands: { findFirst: vi.fn(), findMany: vi.fn() },
      pages: { findFirst: vi.fn() },
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

import { GET, POST } from '../route';
import { db } from '@pagespace/db/db';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { canUserViewPage, isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import { authenticateRequestWithOptions } from '@/lib/auth';

const mockedAuth = vi.mocked(authenticateRequestWithOptions);
const mockedDb = vi.mocked(db, true);
const mockedCanView = vi.mocked(canUserViewPage);
const mockedIsOwnerOrAdmin = vi.mocked(isDriveOwnerOrAdmin);

const USER_ID = 'user_1';

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

const selectChain = (rows: unknown[]) => ({
  from: vi.fn(() => ({ where: vi.fn().mockResolvedValue(rows) })),
});

const insertChain = (row: unknown) => ({
  values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([row]) })),
});

const getRequest = () => new Request('http://localhost/api/commands');

const postRequest = (body: unknown) =>
  new Request('http://localhost/api/commands', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const validBody = {
  trigger: 'design-review',
  description: 'Runs a design review. Use when reviewing UI changes.',
  entryPageId: 'page_1',
};

const storedCommand = {
  id: 'cmd_1',
  userId: USER_ID,
  driveId: null,
  trigger: 'design-review',
  description: validBody.description,
  entryPageId: 'page_1',
  type: 'document',
  enabled: true,
  createdAt: new Date('2026-06-09T00:00:00Z'),
  updatedAt: new Date('2026-06-09T00:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedAuth.mockResolvedValue(webAuth());
  // Default: page exists, untrashed, viewable, no duplicates
  mockedDb.query.pages.findFirst.mockResolvedValue({
    id: 'page_1',
    driveId: 'drive_1',
    isTrashed: false,
  } as never);
  mockedDb.query.commands.findFirst.mockResolvedValue(undefined as never);
  mockedDb.query.commands.findMany.mockResolvedValue([] as never);
  mockedCanView.mockResolvedValue(true);
  mockedIsOwnerOrAdmin.mockResolvedValue(true);
  mockedDb.insert.mockReturnValue(insertChain(storedCommand) as never);
  mockedDb.select
    .mockReturnValueOnce(selectChain([]) as never)
    .mockReturnValueOnce(selectChain([]) as never);
});

describe('GET /api/commands', () => {
  it('returns 401 when authentication fails', async () => {
    mockedAuth.mockResolvedValue(authError() as never);
    const response = await GET(getRequest());
    expect(response.status).toBe(401);
  });

  it('lists personal commands plus commands of drives the user belongs to', async () => {
    mockedDb.select.mockReset();
    mockedDb.select
      .mockReturnValueOnce(selectChain([{ id: 'drive_owned' }]) as never)
      .mockReturnValueOnce(selectChain([{ driveId: 'drive_member' }]) as never);
    mockedDb.query.commands.findMany.mockResolvedValue([
      storedCommand,
      { ...storedCommand, id: 'cmd_2', userId: null, driveId: 'drive_member', trigger: 'team-faq' },
    ] as never);

    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.commands).toHaveLength(2);
    expect(json.commands[0].scope).toBe('user');
    expect(json.commands[1]).toMatchObject({ scope: 'drive', driveId: 'drive_member' });
  });
});

describe('POST /api/commands', () => {
  it('returns 401 when authentication fails', async () => {
    mockedAuth.mockResolvedValue(authError() as never);
    const response = await POST(postRequest(validBody));
    expect(response.status).toBe(401);
  });

  it.each(['Design-Review', '-design', 'design-', 'design--review', '', 'a'.repeat(65)])(
    'rejects invalid trigger %j with 400',
    async (trigger) => {
      const response = await POST(postRequest({ ...validBody, trigger }));
      expect(response.status).toBe(400);
      expect(mockedDb.insert).not.toHaveBeenCalled();
    }
  );

  it("rejects the reserved trigger 'help' for personal scope with 400", async () => {
    const response = await POST(postRequest({ ...validBody, trigger: 'help' }));
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toMatch(/reserved/i);
  });

  it("rejects the reserved trigger 'help' for drive scope with 400", async () => {
    const response = await POST(postRequest({ ...validBody, trigger: 'help', driveId: 'drive_1' }));
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toMatch(/reserved/i);
  });

  it('rejects a missing description with 400', async () => {
    const response = await POST(postRequest({ ...validBody, description: undefined }));
    expect(response.status).toBe(400);
  });

  it('rejects a description over 1024 chars with 400', async () => {
    const response = await POST(postRequest({ ...validBody, description: 'd'.repeat(1025) }));
    expect(response.status).toBe(400);
  });

  it('rejects a missing entryPageId with 400', async () => {
    const response = await POST(postRequest({ ...validBody, entryPageId: undefined }));
    expect(response.status).toBe(400);
  });

  it("rejects types other than 'document' with 400", async () => {
    const response = await POST(postRequest({ ...validBody, type: 'builtin' }));
    expect(response.status).toBe(400);
  });

  it('returns 403 when a plain member tries to create a drive command', async () => {
    mockedIsOwnerOrAdmin.mockResolvedValue(false);
    const response = await POST(postRequest({ ...validBody, driveId: 'drive_1' }));
    expect(response.status).toBe(403);
    expect(mockedDb.insert).not.toHaveBeenCalled();
  });

  it('returns 400 when the entry page does not exist', async () => {
    mockedDb.query.pages.findFirst.mockResolvedValue(undefined as never);
    const response = await POST(postRequest(validBody));
    expect(response.status).toBe(400);
    expect(mockedDb.insert).not.toHaveBeenCalled();
  });

  it('returns 400 when the entry page is trashed', async () => {
    mockedDb.query.pages.findFirst.mockResolvedValue({
      id: 'page_1',
      driveId: 'drive_1',
      isTrashed: true,
    } as never);
    const response = await POST(postRequest(validBody));
    expect(response.status).toBe(400);
  });

  it('returns 403 when the caller cannot view the entry page', async () => {
    mockedCanView.mockResolvedValue(false);
    const response = await POST(postRequest(validBody));
    expect(response.status).toBe(403);
    expect(mockedDb.insert).not.toHaveBeenCalled();
  });

  it('returns 400 when a drive command entry page is in a different drive', async () => {
    mockedDb.query.pages.findFirst.mockResolvedValue({
      id: 'page_1',
      driveId: 'other_drive',
      isTrashed: false,
    } as never);
    const response = await POST(postRequest({ ...validBody, driveId: 'drive_1' }));
    expect(response.status).toBe(400);
    expect(mockedDb.insert).not.toHaveBeenCalled();
  });

  it('returns 409 when the trigger already exists in the same scope', async () => {
    mockedDb.query.commands.findFirst.mockResolvedValue(storedCommand as never);
    const response = await POST(postRequest(validBody));
    expect(response.status).toBe(409);
    expect(mockedDb.insert).not.toHaveBeenCalled();
  });

  it('returns 409 (not 500) when the unique index trips on a concurrent insert', async () => {
    mockedDb.insert.mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn().mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' })),
      })),
    } as never);
    const response = await POST(postRequest(validBody));
    expect(response.status).toBe(409);
  });

  it('creates a personal command and audits the write', async () => {
    const response = await POST(postRequest(validBody));
    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.command).toMatchObject({
      id: 'cmd_1',
      trigger: 'design-review',
      scope: 'user',
    });
    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write', userId: USER_ID })
    );
  });

  it('creates a drive command when the caller is owner/admin', async () => {
    mockedDb.insert.mockReturnValue(
      insertChain({ ...storedCommand, userId: null, driveId: 'drive_1' }) as never
    );
    const response = await POST(postRequest({ ...validBody, driveId: 'drive_1' }));
    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.command.scope).toBe('drive');
    expect(mockedIsOwnerOrAdmin).toHaveBeenCalledWith(USER_ID, 'drive_1');
  });

  it('requires CSRF on writes', async () => {
    await POST(postRequest(validBody));
    expect(mockedAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requireCSRF: true })
    );
  });

  it('rejects a non-object body with 400', async () => {
    const response = await POST(postRequest([1, 2, 3]));
    expect(response.status).toBe(400);
  });
});
