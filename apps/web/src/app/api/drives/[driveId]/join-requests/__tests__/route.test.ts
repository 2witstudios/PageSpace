/**
 * /api/drives/[driveId]/join-requests and /[requestId] (Spec DRV-6, D-OW-22). The service is faked
 * at the lib boundary (its decisions and real-Postgres behaviour are tested in packages/lib); these
 * tests pin what the routes add: dark 404, session-only auth with CSRF on mutations, body
 * validation, the caller passed through, the service verdict answered as is, and audit events for
 * request, approve, deny and withdraw.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

const flags = vi.hoisted(() => ({ orgsEnabled: true }));

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/repository', () => ({ findMembershipRole: vi.fn() }));

vi.mock('@pagespace/lib/services/drive-join-request-service', () => ({
  JOIN_REQUEST_MESSAGE_MAX: 500,
  requestToJoinDrive: vi.fn(),
  listPendingDriveJoinRequests: vi.fn(),
  answerDriveJoinRequest: vi.fn(),
  withdrawDriveJoinRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions/drive-relationship-loader', () => ({
  recordOrgPowerDriveAction: vi.fn().mockResolvedValue(undefined),
}));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import {
  answerDriveJoinRequest,
  listPendingDriveJoinRequests,
  requestToJoinDrive,
  withdrawDriveJoinRequest,
} from '@pagespace/lib/services/drive-join-request-service';
import { recordOrgPowerDriveAction } from '@pagespace/lib/permissions/drive-relationship-loader';
import { GET, POST } from '../route';
import { PATCH, DELETE } from '../[requestId]/route';

const LENA = 'user-lena';
const MARCUS = 'user-marcus';
const DRIVE = 'drive-research';
const REQUEST_ID = 'req-1';
const NORTHWIND = 'org-northwind';

const session = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'session-1',
  role: 'user',
  adminRoleVersion: 0,
});

const driveContext = { params: Promise.resolve({ driveId: DRIVE }) };
const requestContext = { params: Promise.resolve({ driveId: DRIVE, requestId: REQUEST_ID }) };

const call = (method: string, body?: unknown) =>
  new Request(`https://example.com/api/drives/${DRIVE}/join-requests`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const pendingRequest = { id: REQUEST_ID, driveId: DRIVE, userId: LENA, status: 'pending', message: null };
const research = { id: DRIVE, name: 'Research', ownerId: MARCUS, orgId: NORTHWIND, orgVisibility: 'RESTRICTED' as const };

describe('drive join request routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flags.orgsEnabled = true;
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session(LENA));
  });

  it.each([
    ['GET', () => GET(call('GET'), driveContext)],
    ['POST', () => POST(call('POST', {}), driveContext)],
    ['PATCH', () => PATCH(call('PATCH', { decision: 'approve' }), requestContext)],
    ['DELETE', () => DELETE(call('DELETE'), requestContext)],
  ] as const)('%s answers 404 and does nothing while ORGS_ENABLED is false', async (_method, run) => {
    flags.orgsEnabled = false;

    const response = await run();

    expect(response.status).toBe(404);
    expect(authenticateRequestWithOptions).not.toHaveBeenCalled();
    for (const service of [requestToJoinDrive, listPendingDriveJoinRequests, answerDriveJoinRequest, withdrawDriveJoinRequest]) {
      expect(service).not.toHaveBeenCalled();
    }
  });

  it('DRV-6 (partial) mutations require a session with CSRF; reads a session without it', async () => {
    vi.mocked(requestToJoinDrive).mockResolvedValue({ ok: true, created: true, request: pendingRequest as never, drive: research });
    vi.mocked(listPendingDriveJoinRequests).mockResolvedValue({ ok: true, requests: [] });

    await POST(call('POST', {}), driveContext);
    await GET(call('GET'), driveContext);

    expect(vi.mocked(authenticateRequestWithOptions).mock.calls.map(([, options]) => options)).toEqual([
      { allow: ['session'], requireCSRF: true },
      { allow: ['session'], requireCSRF: false },
    ]);
  });

  describe('POST (request to join)', () => {
    it('DRV-6 (partial) asks as the caller with the note, answers 201 and audits the request', async () => {
      vi.mocked(requestToJoinDrive).mockResolvedValue({ ok: true, created: true, request: pendingRequest as never, drive: research });

      const response = await POST(call('POST', { message: 'I run interviews' }), driveContext);

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ request: pendingRequest });
      expect(requestToJoinDrive).toHaveBeenCalledWith(LENA, DRIVE, { message: 'I run interviews' });
      expect(auditRequest).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({
        eventType: 'data.write',
        userId: LENA,
        resourceType: 'drive_join_request',
        resourceId: REQUEST_ID,
        details: { operation: 'drive_join_request', driveId: DRIVE, orgId: NORTHWIND },
      }));
    });

    it('DRV-6 (partial) a repeated request answers 200 with the open one and writes no second audit event', async () => {
      vi.mocked(requestToJoinDrive).mockResolvedValue({ ok: true, created: false, request: pendingRequest as never, drive: research });

      const response = await POST(call('POST', {}), driveContext);

      expect(response.status).toBe(200);
      expect(auditRequest).not.toHaveBeenCalled();
    });

    it('DRV-6 (partial) a refusal is answered with its status and code', async () => {
      vi.mocked(requestToJoinDrive).mockResolvedValue({ ok: false, code: 'DRIVE_NOT_FOUND', status: 404, message: 'Drive not found' });

      const response = await POST(call('POST', {}), driveContext);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Drive not found', code: 'DRIVE_NOT_FOUND' });
    });

    it('DRV-6 (partial) an unknown field or an overlong note is rejected before the service runs', async () => {
      expect((await POST(call('POST', { role: 'ADMIN' }), driveContext)).status).toBe(400);
      expect((await POST(call('POST', { message: 'x'.repeat(501) }), driveContext)).status).toBe(400);
      expect(requestToJoinDrive).not.toHaveBeenCalled();
    });
  });

  describe('GET (pending requests)', () => {
    it('DRV-6 (partial) lists for the caller, or answers the approver refusal', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session(MARCUS));
      vi.mocked(listPendingDriveJoinRequests).mockResolvedValueOnce({ ok: true, requests: [{ id: REQUEST_ID, userId: LENA } as never] });

      const listed = await GET(call('GET'), driveContext);
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ requests: [{ id: REQUEST_ID, userId: LENA }] });
      expect(listPendingDriveJoinRequests).toHaveBeenCalledWith(MARCUS, DRIVE);

      vi.mocked(listPendingDriveJoinRequests).mockResolvedValueOnce({ ok: false, code: 'NOT_APPROVER', status: 403, message: 'no' });
      expect((await GET(call('GET'), driveContext)).status).toBe(403);
    });
  });

  describe('PATCH (approve or deny)', () => {
    it('DRV-6 (partial) approves as the caller, audits the approval with the requester, and records org power (ORG-4)', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session(MARCUS));
      vi.mocked(answerDriveJoinRequest).mockResolvedValue({
        ok: true, action: 'approve', admitted: true, request: { ...pendingRequest, status: 'approved' } as never, drive: research,
      });

      const response = await PATCH(call('PATCH', { decision: 'approve' }), requestContext);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ admitted: true, request: { status: 'approved' } });
      expect(answerDriveJoinRequest).toHaveBeenCalledWith(MARCUS, DRIVE, REQUEST_ID, 'approve');
      expect(auditRequest).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({
        userId: MARCUS,
        resourceType: 'drive_join_request',
        details: { operation: 'drive_join_request_approve', driveId: DRIVE, orgId: NORTHWIND, requesterId: LENA, admitted: true },
      }));
      expect(recordOrgPowerDriveAction).toHaveBeenCalledWith(MARCUS, research, 'answer_join_request');
    });

    it('DRV-6 (partial) a denial is audited as a refusal', async () => {
      vi.mocked(answerDriveJoinRequest).mockResolvedValue({
        ok: true, action: 'deny', admitted: false, request: { ...pendingRequest, status: 'denied' } as never, drive: research,
      });

      await PATCH(call('PATCH', { decision: 'deny' }), requestContext);

      expect(auditRequest).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({
        details: expect.objectContaining({ operation: 'drive_join_request_deny', admitted: false }),
      }));
    });

    it('DRV-6 (partial) self-approval is refused with the service verdict, and nothing is audited', async () => {
      vi.mocked(answerDriveJoinRequest).mockResolvedValue({ ok: false, code: 'SELF_DECISION', status: 403, message: 'no' });

      const response = await PATCH(call('PATCH', { decision: 'approve' }), requestContext);

      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('SELF_DECISION');
      expect(auditRequest).not.toHaveBeenCalled();
      expect(recordOrgPowerDriveAction).not.toHaveBeenCalled();
    });

    it('DRV-6 (partial) any decision but approve or deny is rejected before the service runs', async () => {
      expect((await PATCH(call('PATCH', { decision: 'accept' }), requestContext)).status).toBe(400);
      expect(answerDriveJoinRequest).not.toHaveBeenCalled();
    });
  });

  describe('DELETE (withdraw)', () => {
    it('DRV-6 (partial) withdraws as the caller and audits it; a refusal is answered as is', async () => {
      vi.mocked(withdrawDriveJoinRequest).mockResolvedValueOnce({ ok: true, request: { ...pendingRequest, status: 'withdrawn' } as never });

      const response = await DELETE(call('DELETE'), requestContext);
      expect(response.status).toBe(200);
      expect(withdrawDriveJoinRequest).toHaveBeenCalledWith(LENA, DRIVE, REQUEST_ID);
      expect(auditRequest).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({
        details: { operation: 'drive_join_request_withdraw', driveId: DRIVE },
      }));

      vi.mocked(withdrawDriveJoinRequest).mockResolvedValueOnce({ ok: false, code: 'REQUEST_NOT_FOUND', status: 404, message: 'Join request not found' });
      expect((await DELETE(call('DELETE'), requestContext)).status).toBe(404);
    });
  });
});
