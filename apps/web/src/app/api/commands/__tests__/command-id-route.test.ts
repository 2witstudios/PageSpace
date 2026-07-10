import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      commands: { findFirst: vi.fn() },
      pages: { findFirst: vi.fn() },
    },
    update: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  ne: vi.fn((field: unknown, value: unknown) => ({ ne: [field, value] })),
}));
vi.mock('@pagespace/db/schema/commands', () => ({
  commands: { id: 'id', userId: 'userId', driveId: 'driveId', trigger: 'trigger' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', isTrashed: 'isTrashed' },
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
}));
vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn(
    (result: unknown) => !!result && typeof result === 'object' && 'error' in (result as object)
  ),
  checkMCPDriveScope: vi.fn(),
}));
vi.mock('@/lib/auth/principal-permissions', () => ({
  canPrincipalViewPage: vi.fn(),
}));

import { PATCH, DELETE } from '../[commandId]/route';
import { db } from '@pagespace/db/db';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import type { SessionAuthResult, AuthError } from '@/lib/auth/auth-types';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { checkMCPDriveScope } from '@/lib/auth/auth-core';
import { canPrincipalViewPage } from '@/lib/auth/principal-permissions';

const mockedAuth = vi.mocked(authenticateRequestWithOptions);
const mockedDb = vi.mocked(db, true);
const mockedCanView = vi.mocked(canPrincipalViewPage);
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

const personalCommand = {
  id: 'cmd_1',
  userId: USER_ID,
  driveId: null,
  trigger: 'design-review',
  description: 'Runs a design review.',
  entryPageId: 'page_1',
  type: 'document',
  enabled: true,
  createdAt: new Date('2026-06-09T00:00:00Z'),
  updatedAt: new Date('2026-06-09T00:00:00Z'),
};

const driveCommand = {
  ...personalCommand,
  id: 'cmd_2',
  userId: null,
  driveId: 'drive_1',
};

const updateChain = (row: unknown) => ({
  set: vi.fn(() => ({
    where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([row]) })),
  })),
});

const params = (commandId: string) => ({ params: Promise.resolve({ commandId }) });

const patchRequest = (body: unknown) =>
  new Request('http://localhost/api/commands/cmd_1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const deleteRequest = () =>
  new Request('http://localhost/api/commands/cmd_1', { method: 'DELETE' });

beforeEach(() => {
  vi.clearAllMocks();
  mockedAuth.mockResolvedValue(webAuth());
  vi.mocked(checkMCPDriveScope).mockReturnValue(null);
  mockedDb.query.commands.findFirst.mockResolvedValue(personalCommand as never);
  mockedDb.query.pages.findFirst.mockResolvedValue({
    id: 'page_2',
    driveId: 'drive_1',
    isTrashed: false,
  } as never);
  mockedCanView.mockResolvedValue(true);
  mockedIsOwnerOrAdmin.mockResolvedValue(true);
  mockedDb.update.mockReturnValue(updateChain({ ...personalCommand, enabled: false }) as never);
  mockedDb.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) } as never);
});

describe('PATCH /api/commands/[commandId]', () => {
  it('returns 401 when authentication fails', async () => {
    mockedAuth.mockResolvedValue(authError() as never);
    const response = await PATCH(patchRequest({ enabled: false }), params('cmd_1'));
    expect(response.status).toBe(401);
  });

  it('returns 404 for a nonexistent command', async () => {
    mockedDb.query.commands.findFirst.mockResolvedValue(undefined as never);
    const response = await PATCH(patchRequest({ enabled: false }), params('missing'));
    expect(response.status).toBe(404);
  });

  it("returns 404 for another user's personal command", async () => {
    mockedDb.query.commands.findFirst.mockResolvedValue({
      ...personalCommand,
      userId: 'someone_else',
    } as never);
    const response = await PATCH(patchRequest({ enabled: false }), params('cmd_1'));
    expect(response.status).toBe(404);
    expect(mockedDb.update).not.toHaveBeenCalled();
  });

  it('returns 403 when a non-admin member edits a drive command', async () => {
    mockedDb.query.commands.findFirst.mockResolvedValue(driveCommand as never);
    mockedIsOwnerOrAdmin.mockResolvedValue(false);
    const response = await PATCH(patchRequest({ enabled: false }), params('cmd_2'));
    expect(response.status).toBe(403);
    expect(mockedDb.update).not.toHaveBeenCalled();
  });

  it('rejects an invalid replacement trigger with 400', async () => {
    const response = await PATCH(patchRequest({ trigger: 'Bad--Trigger' }), params('cmd_1'));
    expect(response.status).toBe(400);
  });

  it('rejects a reserved replacement trigger with 400', async () => {
    const response = await PATCH(patchRequest({ trigger: 'help' }), params('cmd_1'));
    expect(response.status).toBe(400);
  });

  it('returns 409 when the new trigger collides in the same scope', async () => {
    mockedDb.query.commands.findFirst
      .mockResolvedValueOnce(personalCommand as never) // load
      .mockResolvedValueOnce({ ...personalCommand, id: 'cmd_other' } as never); // duplicate
    const response = await PATCH(patchRequest({ trigger: 'other-trigger' }), params('cmd_1'));
    expect(response.status).toBe(409);
  });

  it('rejects scope changes with 400', async () => {
    const response = await PATCH(patchRequest({ driveId: 'drive_2' }), params('cmd_1'));
    expect(response.status).toBe(400);
  });

  it('returns 400 when a new entry page does not exist', async () => {
    mockedDb.query.pages.findFirst.mockResolvedValue(undefined as never);
    const response = await PATCH(patchRequest({ entryPageId: 'missing_page' }), params('cmd_1'));
    expect(response.status).toBe(400);
    expect(mockedDb.update).not.toHaveBeenCalled();
  });

  it('returns 400 when a new entry page is trashed', async () => {
    mockedDb.query.pages.findFirst.mockResolvedValue({
      id: 'page_2',
      driveId: 'drive_1',
      isTrashed: true,
    } as never);
    const response = await PATCH(patchRequest({ entryPageId: 'page_2' }), params('cmd_1'));
    expect(response.status).toBe(400);
  });

  it('returns 403 when the caller cannot view the new entry page', async () => {
    mockedCanView.mockResolvedValue(false);
    const response = await PATCH(patchRequest({ entryPageId: 'page_2' }), params('cmd_1'));
    expect(response.status).toBe(403);
  });

  it("returns 400 when a drive command's new entry page is in a different drive", async () => {
    mockedDb.query.commands.findFirst.mockResolvedValue(driveCommand as never);
    mockedDb.query.pages.findFirst.mockResolvedValue({
      id: 'page_2',
      driveId: 'other_drive',
      isTrashed: false,
    } as never);
    const response = await PATCH(patchRequest({ entryPageId: 'page_2' }), params('cmd_2'));
    expect(response.status).toBe(400);
  });

  it('updates the command and audits the write', async () => {
    const response = await PATCH(patchRequest({ enabled: false }), params('cmd_1'));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.command.enabled).toBe(false);
    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write', resourceId: 'cmd_1' })
    );
  });

  it('returns 400 when no updatable field is provided', async () => {
    const response = await PATCH(patchRequest({}), params('cmd_1'));
    expect(response.status).toBe(400);
  });
});

describe('DELETE /api/commands/[commandId]', () => {
  it('returns 401 when authentication fails', async () => {
    mockedAuth.mockResolvedValue(authError() as never);
    const response = await DELETE(deleteRequest(), params('cmd_1'));
    expect(response.status).toBe(401);
  });

  it('returns 404 for a nonexistent command', async () => {
    mockedDb.query.commands.findFirst.mockResolvedValue(undefined as never);
    const response = await DELETE(deleteRequest(), params('missing'));
    expect(response.status).toBe(404);
  });

  it('returns 403 when a non-admin member deletes a drive command', async () => {
    mockedDb.query.commands.findFirst.mockResolvedValue(driveCommand as never);
    mockedIsOwnerOrAdmin.mockResolvedValue(false);
    const response = await DELETE(deleteRequest(), params('cmd_2'));
    expect(response.status).toBe(403);
    expect(mockedDb.delete).not.toHaveBeenCalled();
  });

  it('deletes a personal command and audits it', async () => {
    const response = await DELETE(deleteRequest(), params('cmd_1'));
    expect(response.status).toBe(200);
    expect(mockedDb.delete).toHaveBeenCalled();
    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.delete', resourceId: 'cmd_1' })
    );
  });

  it('deletes a drive command when the caller is owner/admin', async () => {
    mockedDb.query.commands.findFirst.mockResolvedValue(driveCommand as never);
    const response = await DELETE(deleteRequest(), params('cmd_2'));
    expect(response.status).toBe(200);
    expect(mockedIsOwnerOrAdmin).toHaveBeenCalledWith(USER_ID, 'drive_1');
  });
});
