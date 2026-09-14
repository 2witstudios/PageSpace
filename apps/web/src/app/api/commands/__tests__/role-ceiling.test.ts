/**
 * Role-ceiling escape fixed for ALL principals (point-guard ruling): drive
 * commands were authorized with `isDriveOwnerOrAdmin(userId)` — the USER's role —
 * so a `drive:X:member` credential held by X's admin could manage X's commands,
 * and a drive-scoped credential could create, change or delete the user's
 * PERSONAL commands (identity-bound, not in any drive). Now drive commands
 * authorize through `isPrincipalDriveOwnerOrAdmin(auth)` and a drive-scoped
 * principal gets a constant 403 on personal commands. Sessions unchanged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { commands: { findFirst: vi.fn() } },
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 'cmd-new', userId: null, driveId: 'drivex', trigger: 'go', description: 'd', entryPageId: 'p', type: 'document', enabled: true, createdAt: new Date(), updatedAt: new Date() }]) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 'cmd', userId: null, driveId: 'drivex', trigger: 'go', description: 'd', entryPageId: 'p', type: 'document', enabled: false, createdAt: new Date(), updatedAt: new Date() }]) })) })) })),
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
  },
}));
vi.mock('@pagespace/lib/permissions/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/permissions/permissions')>()),
  // The owning user IS an admin of every drive here.
  isDriveOwnerOrAdmin: vi.fn(async () => true),
}));
vi.mock('@pagespace/lib/permissions/app-permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/permissions/app-permissions')>()),
  ...(await import('@/lib/auth/__tests__/oauth-principal-fixture')).stillMemberScopedResolvers(),
  getAppDriveMembership: vi.fn(),
}));
vi.mock('../command-route-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../command-route-helpers')>()),
  validateEntryPage: vi.fn(async () => null),
}));
vi.mock('@pagespace/lib/services/drive-member-service', () => ({ getDriveRecipientUserIds: vi.fn(async () => []) }));
vi.mock('@/lib/websocket/socket-utils', () => ({ broadcastDriveEvent: vi.fn(async () => undefined), createDriveEventPayload: vi.fn() }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  logSecurityEvent: vi.fn(),
}));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, authenticateRequestWithOptions: vi.fn() };
});

import { POST } from '../route';
import { PATCH, DELETE } from '../[commandId]/route';
import { db } from '@pagespace/db/db';
import { authenticateRequestWithOptions, type AuthResult } from '@/lib/auth';
import { getAppDriveMembership } from '@pagespace/lib/permissions/app-permissions';
import { isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import { PARITY_USER_ID, mcpDriveKey, oauthDriveGrant } from '@/lib/auth/__tests__/oauth-principal-fixture';

const session: AuthResult = { tokenType: 'session', sessionId: 's', userId: PARITY_USER_ID, role: 'user', tokenVersion: 0, adminRoleVersion: 0 };
const DRIVE_CEILING = { error: 'Only the drive owner or admins can manage drive commands' };
const PERSONAL_REFUSED = { error: 'Drive-scoped credentials cannot manage personal commands' };

const create = (driveId?: string) =>
  POST(new Request('https://example.com/api/commands', {
    method: 'POST',
    body: JSON.stringify({ trigger: 'go', description: 'Go', entryPageId: 'page', ...(driveId ? { driveId } : {}) }),
  }));
const ctx = { params: Promise.resolve({ commandId: 'cmd' }) };
const update = () => PATCH(new Request('https://example.com/api/commands/cmd', { method: 'PATCH', body: JSON.stringify({ enabled: false }) }), ctx);
const remove = () => DELETE(new Request('https://example.com/api/commands/cmd', { method: 'DELETE' }), ctx);

const driveCommand = { id: 'cmd', userId: null, driveId: 'drivex', trigger: 'go', description: 'd', entryPageId: 'p', type: 'document', enabled: true };
const personalCommand = { ...driveCommand, userId: PARITY_USER_ID, driveId: null };

const memberKey = () => {
  vi.mocked(getAppDriveMembership).mockResolvedValue({ role: 'MEMBER', customRoleId: null, ownerUserId: PARITY_USER_ID });
  return mcpDriveKey('drivex');
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(true);
});

describe('commands — the credential role decides drive commands', () => {
  for (const [label, principal] of [
    ['a drive:X:member OAuth grant', () => oauthDriveGrant('drivex', 'member')],
    ['a MEMBER-role mcp_ key', memberKey],
  ] as const) {
    it(`refuses ${label} creating a drive command although its user is X's admin`, async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(principal());
      vi.mocked(db.query.commands.findFirst).mockResolvedValue(undefined);
      const res = await create('drivex');
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(DRIVE_CEILING);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it(`refuses ${label} changing or deleting a drive command`, async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(principal());
      vi.mocked(db.query.commands.findFirst).mockResolvedValue(driveCommand as never);
      expect((await update()).status).toBe(403);
      expect((await remove()).status).toBe(403);
      expect(db.update).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
    });

    it(`refuses ${label} creating, changing or deleting a PERSONAL command`, async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(principal());
      vi.mocked(db.query.commands.findFirst).mockResolvedValue(undefined);
      const created = await create();
      expect(created.status).toBe(403);
      expect(await created.json()).toEqual(PERSONAL_REFUSED);

      vi.mocked(db.query.commands.findFirst).mockResolvedValue(personalCommand as never);
      const updated = await update();
      expect(updated.status).toBe(403);
      expect(await updated.json()).toEqual(PERSONAL_REFUSED);
      expect((await remove()).status).toBe(403);
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
    });
  }

  // A credential never exceeds its user's CURRENT drive role: a user demoted
  // ADMIN→MEMBER keeps an explicit-ADMIN credential (roles are frozen at grant
  // time), so the credential's role alone must not admit it.
  for (const [label, principal] of [
    ['an ADMIN OAuth grant', () => oauthDriveGrant('drivex', 'admin')],
    ['an ADMIN-role mcp_ key', () => {
      vi.mocked(getAppDriveMembership).mockResolvedValue({ role: 'ADMIN', customRoleId: null, ownerUserId: PARITY_USER_ID });
      return mcpDriveKey('drivex');
    }],
  ] as const) {
    it(`refuses ${label} whose user has since been demoted to MEMBER`, async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(principal());
      vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);
      vi.mocked(db.query.commands.findFirst).mockResolvedValue(undefined);
      const created = await create('drivex');
      expect(created.status).toBe(403);
      expect(await created.json()).toEqual(DRIVE_CEILING);

      vi.mocked(db.query.commands.findFirst).mockResolvedValue(driveCommand as never);
      expect((await update()).status).toBe(403);
      expect((await remove()).status).toBe(403);
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
    });
  }

  it('admits a drive:X:admin OAuth grant creating a drive command (positive control)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant('drivex', 'admin'));
    vi.mocked(db.query.commands.findFirst).mockResolvedValue(undefined);
    expect((await create('drivex')).status).toBe(201);
  });

  it('leaves a session admin managing drive and personal commands unchanged', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session);
    vi.mocked(db.query.commands.findFirst).mockResolvedValue(undefined);
    expect((await create('drivex')).status).toBe(201);
    expect((await create()).status).toBe(201);
    vi.mocked(db.query.commands.findFirst).mockResolvedValueOnce(personalCommand as never).mockResolvedValueOnce(undefined);
    expect((await update()).status).toBe(200);
  });
});
