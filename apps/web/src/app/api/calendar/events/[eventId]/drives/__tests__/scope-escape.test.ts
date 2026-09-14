/**
 * Scope escape fixed for ALL drive-scoped principals: sharing an event INTO a
 * drive writes that drive's calendar, so the target drive must pass the
 * credential's scope. The route gated only the event's home drive and the
 * service checks the owning USER's membership of the target, so a credential
 * scoped to X could share an X event into any drive Y its user belongs to.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [{ driveId: 'drivex' }] }) }) })) },
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

const session: AuthResult = { tokenType: 'session', sessionId: 's', userId: PARITY_USER_ID, role: 'user', tokenVersion: 0, adminRoleVersion: 0 };
const share = (driveId: string) =>
  POST(new Request('https://example.com/api/calendar/events/evt/drives', { method: 'POST', body: JSON.stringify({ driveId }) }), {
    params: Promise.resolve({ eventId: 'evt' }),
  });

beforeEach(() => vi.clearAllMocks());

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
