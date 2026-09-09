/**
 * Contract tests for the four status/action routes behind the detection
 * affordance and the preview pane: dark ⇒ 404 before auth; the route's own
 * gate (session family policy / drive member / drive owner-admin); the shared
 * gather's verdict; the holder rule for env-bound sessions; action-body
 * validation; the "no preview to switch" 404; audit on every write.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, security: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(() => false),
  isPrincipalDriveMember: vi.fn(),
  isPrincipalDriveOwnerOrAdmin: vi.fn(),
}));
vi.mock('@pagespace/lib/services/sandbox/preview/dev-preview-env', () => ({
  isDevPreviewConfigured: vi.fn(() => true),
}));
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({ resolveEnvInDrive: vi.fn() }));
vi.mock('@/lib/agent-workspaces/agent-workspaces-runtime', () => ({ findSessionRecord: vi.fn() }));
vi.mock('@/lib/agent-workspaces/workspace-unavailable-response', () => ({
  workspaceNotFoundOrDenied: vi.fn(() => new Response(null, { status: 404 })),
}));
vi.mock('@/lib/dev-preview/preview-runtime', () => ({
  readDevPreviewStatusForUser: vi.fn(),
  applyDevPreviewUserActionForHolder: vi.fn(),
  authorizePreviewHolderForUser: vi.fn(),
}));

import { GET as sessionStatus } from '../../agent-workspaces/[workspaceId]/preview/route';
import { POST as sessionAction } from '../../agent-workspaces/[workspaceId]/preview/actions/route';
import { GET as envStatus } from '../../drives/[driveId]/envs/[envId]/preview/route';
import { POST as envAction } from '../../drives/[driveId]/envs/[envId]/preview/actions/route';
import { authenticateRequestWithOptions, isAuthError, isPrincipalDriveMember, isPrincipalDriveOwnerOrAdmin } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isDevPreviewConfigured } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import { resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';
import { findSessionRecord } from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { workspaceNotFoundOrDenied } from '@/lib/agent-workspaces/workspace-unavailable-response';
import { readDevPreviewStatusForUser, applyDevPreviewUserActionForHolder, authorizePreviewHolderForUser } from '@/lib/dev-preview/preview-runtime';

const envCtx = { params: Promise.resolve({ driveId: 'd1', envId: 'env1' }) };
const wsCtx = { params: Promise.resolve({ workspaceId: 'ws1' }) };

const STATUS = {
  holder: { kind: 'env', id: 'env1' },
  sandbox: 'attached',
  state: { status: 'live', targetPort: 5173, via: 'relay', message: 'Relaying…' },
  slot: { known: false },
  openPath: '/api/drives/d1/envs/env1/preview/open',
  canOpen: true,
  canStop: true,
  canResume: false,
  detectedAt: new Date('2026-09-06T11:00:00.000Z'),
} as const;

function get(): Request {
  return new Request('https://app.pagespace.ai/x');
}
function post(body: unknown): Request {
  return new Request('https://app.pagespace.ai/x', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isDevPreviewConfigured).mockReturnValue(true);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: 'u1' } as never);
  vi.mocked(isAuthError).mockReturnValue(false);
  vi.mocked(isPrincipalDriveMember).mockResolvedValue(true);
  vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(true);
  vi.mocked(resolveEnvInDrive).mockResolvedValue({ id: 'env1', driveId: 'd1', substrate: 'sprite' } as never);
  vi.mocked(findSessionRecord).mockResolvedValue({ id: 'ws1', envId: null, ownerId: 'u1', driveId: 'd1' } as never);
  vi.mocked(readDevPreviewStatusForUser).mockResolvedValue({ ok: true, status: STATUS as never });
  vi.mocked(authorizePreviewHolderForUser).mockResolvedValue({ allowed: true, driveId: 'd1', wakeSubject: { driveId: 'd1', ownerId: 'o' }, sandboxId: 'sbx' });
  vi.mocked(applyDevPreviewUserActionForHolder).mockResolvedValue({ ok: true, applied: { action: 'stop-relay', relayServiceName: 'pagespace-preview-relay' } });
});

describe('GET /api/agent-workspaces/[workspaceId]/preview', () => {
  it('answers the status, authorizing as the session and reading the SESSION holder for a plain session; canManage = session owner', async () => {
    const res = await sessionStatus(get(), wsCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.preview.state.status).toBe('live');
    expect(body.preview.detectedAt).toBe('2026-09-06T11:00:00.000Z');
    expect(body.preview.canManage).toBe(true);
    expect(readDevPreviewStatusForUser).toHaveBeenCalledWith({ authorizeAs: { kind: 'workspace', id: 'ws1' }, holder: { kind: 'workspace', id: 'ws1' }, userId: 'u1' });
    // The drive role is never consulted for a session-holder preview.
    expect(isPrincipalDriveOwnerOrAdmin).not.toHaveBeenCalled();

    vi.mocked(findSessionRecord).mockResolvedValueOnce({ id: 'ws1', envId: null, ownerId: 'someone-else', driveId: 'd1' } as never);
    expect((await (await sessionStatus(get(), wsCtx)).json()).preview.canManage).toBe(false);
  });

  it('for an ENV-BOUND session reads the ENV holder (the holder rule) while still authorizing as the session; canManage = drive owner/admin, NOT session ownership', async () => {
    vi.mocked(findSessionRecord).mockResolvedValue({ id: 'ws1', envId: 'env1', ownerId: 'u1', driveId: 'd1' } as never);
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValueOnce(false);
    const denied = await (await sessionStatus(get(), wsCtx)).json();
    expect(readDevPreviewStatusForUser).toHaveBeenCalledWith({ authorizeAs: { kind: 'workspace', id: 'ws1' }, holder: { kind: 'env', id: 'env1' }, userId: 'u1' });
    expect(denied.preview.canManage).toBe(false);
    expect(isPrincipalDriveOwnerOrAdmin).toHaveBeenCalledWith({ userId: 'u1' }, 'd1');
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValueOnce(true);
    expect((await (await sessionStatus(get(), wsCtx)).json()).preview.canManage).toBe(true);
  });

  it('is dark (404) before authentication when not configured', async () => {
    vi.mocked(isDevPreviewConfigured).mockReturnValue(false);
    expect((await sessionStatus(get(), wsCtx)).status).toBe(404);
    expect(authenticateRequestWithOptions).not.toHaveBeenCalled();
  });

  it('answers the family 404 for an unknown session and for a gather refusal (with the reason handed to the audit helper)', async () => {
    vi.mocked(findSessionRecord).mockResolvedValueOnce(null);
    expect((await sessionStatus(get(), wsCtx)).status).toBe(404);
    expect(workspaceNotFoundOrDenied).toHaveBeenCalledWith(expect.anything(), 'u1', 'ws1', 'session_not_found', expect.any(String));
    vi.mocked(readDevPreviewStatusForUser).mockResolvedValueOnce({ ok: false, reason: 'not-authorized', detail: 'drive_access_denied' });
    expect((await sessionStatus(get(), wsCtx)).status).toBe(404);
    expect(workspaceNotFoundOrDenied).toHaveBeenLastCalledWith(expect.anything(), 'u1', 'ws1', 'drive_access_denied', expect.any(String));
  });

  it('returns the auth layer\'s own error when unauthenticated, and 500s on a thrown gather', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValueOnce({ error: new Response(null, { status: 401 }) } as never);
    vi.mocked(isAuthError).mockReturnValueOnce(true);
    expect((await sessionStatus(get(), wsCtx)).status).toBe(401);
    vi.mocked(readDevPreviewStatusForUser).mockRejectedValueOnce(new Error('boom'));
    expect((await sessionStatus(get(), wsCtx)).status).toBe(500);
  });
});

describe('POST /api/agent-workspaces/[workspaceId]/preview/actions', () => {
  it('applies a stop to the session holder after the session access decision (as the OWNER), passing the payer as wake subject, and audits the write', async () => {
    const res = await sessionAction(post({ action: 'stop' }), wsCtx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: { action: 'stop-relay', relayServiceName: 'pagespace-preview-relay' } });
    expect(authorizePreviewHolderForUser).toHaveBeenCalledWith({ holder: { kind: 'workspace', id: 'ws1' }, userId: 'u1' });
    expect(applyDevPreviewUserActionForHolder).toHaveBeenCalledWith({ holder: { kind: 'workspace', id: 'ws1' }, action: { kind: 'stop' }, userId: 'u1', wakeSubject: { driveId: 'd1', ownerId: 'o' }, sandboxId: 'sbx' });
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.write', resourceType: 'dev_preview', details: expect.objectContaining({ action: 'stop', applied: 'stop-relay' }) }));
  });

  it('AUTHZ: a session-holder preview may only be switched by the session OWNER — a drive admin with session access still 403s (audited), applying nothing', async () => {
    vi.mocked(findSessionRecord).mockResolvedValueOnce({ id: 'ws1', envId: null, ownerId: 'someone-else', driveId: 'd1' } as never);
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(true);
    const res = await sessionAction(post({ action: 'stop' }), wsCtx);
    expect(res.status).toBe(403);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', details: expect.objectContaining({ reason: 'session_manage_requires_owner' }) }));
    expect(applyDevPreviewUserActionForHolder).not.toHaveBeenCalled();
  });

  it('AUTHZ: for an ENV-BOUND session the action lands on the ENV holder and requires the env write bar (drive owner/admin) — a plain member who OWNS the session still 403s; an admin passes', async () => {
    vi.mocked(findSessionRecord).mockResolvedValue({ id: 'ws1', envId: 'env1', ownerId: 'u1', driveId: 'd1' } as never);
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValueOnce(false);
    const denied = await sessionAction(post({ action: 'resume' }), wsCtx);
    expect(denied.status).toBe(403);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', details: expect.objectContaining({ reason: 'env_manage_requires_owner_or_admin' }) }));
    expect(applyDevPreviewUserActionForHolder).not.toHaveBeenCalled();

    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValueOnce(true);
    expect((await sessionAction(post({ action: 'resume' }), wsCtx)).status).toBe(200);
    expect(applyDevPreviewUserActionForHolder).toHaveBeenCalledWith({ holder: { kind: 'env', id: 'env1' }, action: { kind: 'resume' }, userId: 'u1', wakeSubject: { driveId: 'd1', ownerId: 'o' }, sandboxId: 'sbx' });
  });

  it('a DEFERRED relay is a success, not a toast: the intent landed and only the start waits', async () => {
    // `post()` throws on any 4xx, so answering `slot-unknown` with a 409 made
    // the pane say "Could not switch the preview on" over a click that had
    // already cleared the stop. It is the same shape as a contended lock,
    // which is reported as a success.
    vi.mocked(applyDevPreviewUserActionForHolder).mockResolvedValueOnce({ ok: false, reason: 'slot-unknown' });
    const res = await sessionAction(post({ action: 'resume' }), wsCtx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, applied: null, deferred: 'awaiting-port-snapshot' });
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'data.write',
      details: expect.objectContaining({ deferred: 'awaiting-port-snapshot' }),
    }));
  });

  it('APPROVE carries the port through, and a port that moved answers 409 rather than sharing the wrong thing', async () => {
    const res = await sessionAction(post({ action: 'approve', port: 9000, spriteInstanceId: 'inst-1' }), wsCtx);
    expect(res.status).toBe(200);
    expect(applyDevPreviewUserActionForHolder).toHaveBeenCalledWith({ holder: { kind: 'workspace', id: 'ws1' }, action: { kind: 'approve', port: 9000, spriteInstanceId: 'inst-1' }, userId: 'u1', wakeSubject: { driveId: 'd1', ownerId: 'o' }, sandboxId: 'sbx' });
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.write', details: expect.objectContaining({ action: 'approve', port: 9000 }) }));

    // A body with no port is not an approve at all — 400 before anything runs.
    vi.mocked(applyDevPreviewUserActionForHolder).mockClear();
    expect((await sessionAction(post({ action: 'approve' }), wsCtx)).status).toBe(400);
    expect(applyDevPreviewUserActionForHolder).not.toHaveBeenCalled();

    vi.mocked(applyDevPreviewUserActionForHolder).mockResolvedValueOnce({ ok: false, reason: 'port-changed' });
    const moved = await sessionAction(post({ action: 'approve', port: 9000, spriteInstanceId: 'inst-1' }), wsCtx);
    expect(moved.status).toBe(409);
    expect(await moved.json()).toMatchObject({ reason: 'port-changed' });
  });

  it('BILLING: a resume the wake gate refuses is a 403 with the gate reason, audited', async () => {
    vi.mocked(applyDevPreviewUserActionForHolder).mockResolvedValueOnce({ ok: false, reason: 'wake-not-allowed', detail: 'no_capability' });
    const res = await sessionAction(post({ action: 'resume' }), wsCtx);
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe('no_capability');
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', details: expect.objectContaining({ reason: 'wake_not_allowed', detail: 'no_capability' }) }));
  });

  it.each([{ action: 'nuke' }, {}, 'not json', null])('400s a malformed action (%o) before any lookup', async (body) => {
    expect((await sessionAction(post(body), wsCtx)).status).toBe(400);
    expect(findSessionRecord).not.toHaveBeenCalled();
    expect(applyDevPreviewUserActionForHolder).not.toHaveBeenCalled();
  });

  it('answers the family 404 for an unknown or denied session and applies nothing', async () => {
    vi.mocked(findSessionRecord).mockResolvedValueOnce(null);
    expect((await sessionAction(post({ action: 'stop' }), wsCtx)).status).toBe(404);
    vi.mocked(authorizePreviewHolderForUser).mockResolvedValueOnce({ allowed: false, reason: 'drive_access_denied' });
    expect((await sessionAction(post({ action: 'stop' }), wsCtx)).status).toBe(404);
    expect(workspaceNotFoundOrDenied).toHaveBeenLastCalledWith(expect.anything(), 'u1', 'ws1', 'drive_access_denied', expect.any(String));
    expect(applyDevPreviewUserActionForHolder).not.toHaveBeenCalled();
  });

  it('404s with the reason when the session has no preview to switch, and is dark when not configured', async () => {
    vi.mocked(applyDevPreviewUserActionForHolder).mockResolvedValueOnce({ ok: false, reason: 'no-preview' });
    const res = await sessionAction(post({ action: 'stop' }), wsCtx);
    expect(res.status).toBe(404);
    expect((await res.json()).reason).toBe('no-preview');
    vi.mocked(isDevPreviewConfigured).mockReturnValue(false);
    expect((await sessionAction(post({ action: 'stop' }), wsCtx)).status).toBe(404);
  });

  it('500s on a thrown action', async () => {
    vi.mocked(applyDevPreviewUserActionForHolder).mockRejectedValueOnce(new Error('boom'));
    expect((await sessionAction(post({ action: 'stop' }), wsCtx)).status).toBe(500);
  });
});

describe('GET /api/drives/[driveId]/envs/[envId]/preview', () => {
  it('answers the status for a drive member; canManage follows the drive owner/admin verdict', async () => {
    const res = await envStatus(get(), envCtx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.preview.holder).toEqual({ kind: 'env', id: 'env1' });
    expect(body.preview.canManage).toBe(true);
    expect(readDevPreviewStatusForUser).toHaveBeenCalledWith({ authorizeAs: { kind: 'env', id: 'env1' }, userId: 'u1' });
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValueOnce(false);
    expect((await (await envStatus(get(), envCtx)).json()).preview.canManage).toBe(false);
  });

  it('is dark before auth, 403s a non-member (audited), 404s an env outside the drive', async () => {
    vi.mocked(isDevPreviewConfigured).mockReturnValueOnce(false);
    expect((await envStatus(get(), envCtx)).status).toBe(404);
    expect(authenticateRequestWithOptions).not.toHaveBeenCalled();
    vi.mocked(isPrincipalDriveMember).mockResolvedValueOnce(false);
    expect((await envStatus(get(), envCtx)).status).toBe(403);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', resourceType: 'drive' }));
    vi.mocked(resolveEnvInDrive).mockResolvedValueOnce(null);
    expect((await envStatus(get(), envCtx)).status).toBe(404);
    expect(readDevPreviewStatusForUser).not.toHaveBeenCalled();
  });

  it('404s and audits when the shared gather refuses; 500s on a throw', async () => {
    vi.mocked(readDevPreviewStatusForUser).mockResolvedValueOnce({ ok: false, reason: 'not-authorized', detail: 'env_not_sprite' });
    expect((await envStatus(get(), envCtx)).status).toBe(404);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resourceType: 'dev_preview', details: expect.objectContaining({ reason: 'env_not_sprite' }) }));
    vi.mocked(readDevPreviewStatusForUser).mockRejectedValueOnce(new Error('boom'));
    expect((await envStatus(get(), envCtx)).status).toBe(500);
  });
});

describe('POST /api/drives/[driveId]/envs/[envId]/preview/actions', () => {
  it('applies the action for a drive owner/admin with the payer as wake subject, and audits it', async () => {
    const res = await envAction(post({ action: 'resume' }), envCtx);
    expect(res.status).toBe(200);
    expect(authorizePreviewHolderForUser).toHaveBeenCalledWith({ holder: { kind: 'env', id: 'env1' }, userId: 'u1' });
    expect(applyDevPreviewUserActionForHolder).toHaveBeenCalledWith({ holder: { kind: 'env', id: 'env1' }, action: { kind: 'resume' }, userId: 'u1', wakeSubject: { driveId: 'd1', ownerId: 'o' }, sandboxId: 'sbx' });
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.write', resourceId: 'env:env1', details: expect.objectContaining({ action: 'resume' }) }));
  });

  it('BILLING: a wake-gate refusal is 403 (audited); a gather refusal is the uniform 404', async () => {
    vi.mocked(applyDevPreviewUserActionForHolder).mockResolvedValueOnce({ ok: false, reason: 'wake-not-allowed', detail: 'no_capability' });
    expect((await envAction(post({ action: 'resume' }), envCtx)).status).toBe(403);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ details: expect.objectContaining({ reason: 'wake_not_allowed' }) }));
    vi.mocked(authorizePreviewHolderForUser).mockResolvedValueOnce({ allowed: false, reason: 'env_not_sprite' });
    expect((await envAction(post({ action: 'stop' }), envCtx)).status).toBe(404);
  });

  it('403s a plain member (owner/admin only — the env-write bar), audited, applying nothing', async () => {
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValueOnce(false);
    expect((await envAction(post({ action: 'stop' }), envCtx)).status).toBe(403);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied' }));
    expect(applyDevPreviewUserActionForHolder).not.toHaveBeenCalled();
  });

  it('400s a malformed action, 404s an env outside the drive, a local env, and an env with no preview', async () => {
    expect((await envAction(post({ action: 'x' }), envCtx)).status).toBe(400);
    vi.mocked(resolveEnvInDrive).mockResolvedValueOnce(null);
    expect((await envAction(post({ action: 'stop' }), envCtx)).status).toBe(404);
    vi.mocked(resolveEnvInDrive).mockResolvedValueOnce({ id: 'env1', driveId: 'd1', substrate: 'local' } as never);
    const local = await envAction(post({ action: 'stop' }), envCtx);
    expect(local.status).toBe(404);
    expect((await local.json()).reason).toBe('env_not_sprite');
    vi.mocked(applyDevPreviewUserActionForHolder).mockResolvedValueOnce({ ok: false, reason: 'no-preview' });
    expect((await envAction(post({ action: 'stop' }), envCtx)).status).toBe(404);
  });

  it('is dark when not configured and 500s on a throw', async () => {
    vi.mocked(isDevPreviewConfigured).mockReturnValueOnce(false);
    expect((await envAction(post({ action: 'stop' }), envCtx)).status).toBe(404);
    vi.mocked(applyDevPreviewUserActionForHolder).mockRejectedValueOnce(new Error('boom'));
    expect((await envAction(post({ action: 'stop' }), envCtx)).status).toBe(500);
  });
});
