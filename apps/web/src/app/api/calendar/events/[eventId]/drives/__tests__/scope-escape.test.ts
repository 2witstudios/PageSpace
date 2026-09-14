/**
 * Scope escape fixed for ALL drive-scoped principals: sharing an event INTO a
 * drive writes that drive's calendar, so the target drive must pass the
 * credential's scope. The route gated only the event's home drive and the
 * service checks the owning USER's membership of the target, so a credential
 * scoped to X could share an X event into any drive Y its user belongs to.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const eventRow = vi.hoisted(() => ({ current: { driveId: 'drivex', createdById: 'someone-else' } as { driveId: string; createdById: string } }));
vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [eventRow.current] }) }) })) },
}));
// The owning user is an admin and member of both drives; the service mock decides for the user.
vi.mock('@pagespace/lib/permissions/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/permissions/permissions')>()),
  isDriveOwnerOrAdmin: vi.fn(async () => true),
  isUserDriveMember: vi.fn(async () => true),
}));
vi.mock('@pagespace/lib/permissions/app-permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/permissions/app-permissions')>()),
  ...(await import('@/lib/auth/__tests__/oauth-principal-fixture')).stillMemberScopedResolvers(),
  getAppDriveMembership: vi.fn(),
  hasAppDriveMembership: vi.fn(async () => true),
}));
vi.mock('@pagespace/lib/services/calendar-event-drive-service', () => ({
  isUserMemberOfAnyEventDrive: vi.fn(async () => true),
  shareEventWithDrive: vi.fn(async () => ({ ok: true, status: 201, row: { eventId: 'evt' } })),
  unshareEventFromDrive: vi.fn(async () => ({ ok: true })),
  listEventDrives: vi.fn(async () => []),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  logSecurityEvent: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, authenticateRequestWithOptions: vi.fn() };
});

import { DELETE, POST } from '../route';
import { authenticateRequestWithOptions, type AuthResult } from '@/lib/auth';
import { shareEventWithDrive, unshareEventFromDrive } from '@pagespace/lib/services/calendar-event-drive-service';
import { PARITY_USER_ID, mcpDriveKey, oauthDriveGrant } from '@/lib/auth/__tests__/oauth-principal-fixture';
import { getAppDriveMembership } from '@pagespace/lib/permissions/app-permissions';
import type { MCPAuthResult, OAuthAuthResult } from '@/lib/auth';

const session: AuthResult = { tokenType: 'session', sessionId: 's', userId: PARITY_USER_ID, role: 'user', tokenVersion: 0, adminRoleVersion: 0 };
const share = (driveId: string) =>
  POST(new Request('https://example.com/api/calendar/events/evt/drives', { method: 'POST', body: JSON.stringify({ driveId }) }), {
    params: Promise.resolve({ eventId: 'evt' }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  eventRow.current = { driveId: 'drivex', createdById: 'someone-else' };
});

describe('POST /api/calendar/events/[eventId]/drives — the target drive must be in scope', () => {
  for (const [label, principal] of [
    ['a drive:X OAuth grant', oauthDriveGrant('drivex', 'admin')],
    ['a drive-scoped mcp_ key', mcpDriveKey('drivex')],
  ] as const) {
    it(`refuses ${label} sharing an X event into drive Y`, async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(principal);
      const res = await share('drivey');
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'This token does not have access to this drive' });
      expect(shareEventWithDrive).not.toHaveBeenCalled();
    });
  }

  it('lets a session share into any drive the service authorizes (unchanged)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session);
    const res = await share('drivey');
    expect(res.status).toBe(201);
    expect(shareEventWithDrive).toHaveBeenCalledWith({ actingUserId: PARITY_USER_ID, eventId: 'evt', driveId: 'drivey' });
  });
});

describe('DELETE /api/calendar/events/[eventId]/drives — the target drive must be in scope', () => {
  const unshare = (driveId: string) =>
    DELETE(new Request(`https://example.com/api/calendar/events/evt/drives?driveId=${driveId}`, { method: 'DELETE' }), {
      params: Promise.resolve({ eventId: 'evt' }),
    });

  for (const [label, principal] of [
    ['a drive:X OAuth grant', oauthDriveGrant('drivex', 'admin')],
    ['a drive-scoped mcp_ key', mcpDriveKey('drivex')],
  ] as const) {
    it(`refuses ${label} removing an X event's share from drive Y`, async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(principal);
      const res = await unshare('drivey');
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'This token does not have access to this drive' });
      expect(unshareEventFromDrive).not.toHaveBeenCalled();
    });
  }

  it('lets a session unshare as the service authorizes (unchanged)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session);
    const res = await unshare('drivey');
    expect(res.status).toBe(200);
    expect(unshareEventFromDrive).toHaveBeenCalledWith({ actingUserId: PARITY_USER_ID, eventId: 'evt', driveId: 'drivey' });
  });
});

/**
 * Role ceiling (point-guard ruling): sharing or unsharing someone else's event
 * needs home-drive owner/admin authority, which the service decides for the
 * USER. A credential must hold that authority itself too — a MEMBER-role
 * credential of a home-drive admin may not share another user's event.
 */
describe('calendar event drives — home-drive authority needs the credential AND its user', () => {
  const bothDrivesKey = (role: 'MEMBER' | 'ADMIN'): MCPAuthResult => {
    vi.mocked(getAppDriveMembership).mockResolvedValue({ role, customRoleId: null, ownerUserId: PARITY_USER_ID });
    return { ...mcpDriveKey('drivex'), allowedDriveIds: ['drivex', 'drivey'] };
  };
  const bothDrivesGrant = (role: 'MEMBER' | 'ADMIN'): OAuthAuthResult => {
    const grant = oauthDriveGrant('drivex', role === 'ADMIN' ? 'admin' : 'member');
    return { ...grant, allowedDriveIds: ['drivex', 'drivey'], driveScopes: [{ driveId: 'drivex', role, customRoleId: null }, { driveId: 'drivey', role, customRoleId: null }] };
  };
  const unshare = () =>
    DELETE(new Request('https://example.com/api/calendar/events/evt/drives?driveId=drivey', { method: 'DELETE' }), { params: Promise.resolve({ eventId: 'evt' }) });

  for (const [label, principal] of [
    ['a MEMBER-role mcp_ key', () => bothDrivesKey('MEMBER')],
    ['a drive:X,Y:member OAuth grant', () => bothDrivesGrant('MEMBER')],
  ] as const) {
    it(`refuses ${label} sharing or unsharing another user's event`, async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(principal());
      const shared = await share('drivey');
      expect(shared.status).toBe(403);
      expect(await shared.json()).toEqual({ error: 'You do not have permission to share this event' });
      expect((await unshare()).status).toBe(403);
      expect(shareEventWithDrive).not.toHaveBeenCalled();
      expect(unshareEventFromDrive).not.toHaveBeenCalled();
    });

    it(`lets ${label} share its user's OWN event (creator)`, async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(principal());
      eventRow.current = { driveId: 'drivex', createdById: PARITY_USER_ID };
      expect((await share('drivey')).status).toBe(201);
    });
  }

  it('lets an ADMIN-role credential share another user\'s event (the service still checks the user)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(bothDrivesKey('ADMIN'));
    expect((await share('drivey')).status).toBe(201);
    expect(shareEventWithDrive).toHaveBeenCalledTimes(1);
  });
});
