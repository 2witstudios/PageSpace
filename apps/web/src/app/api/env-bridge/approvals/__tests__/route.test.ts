/**
 * GA wave 2, leaf 6 — the owner's click. Contract tests at the runtime seam:
 * Allow re-issues the IDENTICAL frame under the same principal with a
 * server-signed approvalIntent; the clicker must be the env's owner (a drive
 * admin is 403); after the challenge TTL the answer is approval_expired.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }, logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock('@pagespace/lib/services/drive-envs/local-envs-enabled', () => ({ isLocalEnvsEnabled: vi.fn(() => true) }));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn(() => false) }));
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({ getDriveEnvStore: vi.fn(), rememberEnvApproval: vi.fn(async () => null) }));
vi.mock('@/lib/env-bridge/bridge-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env-bridge/bridge-client')>();
  return { ...actual, getEnvBridgeClient: vi.fn() };
});

import { GET, POST } from '../[challengeId]/route';
import { ENV_APPROVAL_STDERR_MAX_CHARS, ENV_APPROVAL_STDOUT_MAX_CHARS, requestEnvApprovalOutputSchema } from '@/lib/ai/tools/env-approval-tools';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { getDriveEnvStore, rememberEnvApproval } from '@/lib/drive-envs/drive-envs-runtime';
import { EnvBridgeError, getEnvBridgeClient } from '@/lib/env-bridge/bridge-client';
import { getPendingApprovalStore, resetPendingApprovalStoreForTesting, type PendingEnvApproval } from '@/lib/env-bridge/pending-approvals';

const OWNER = 'user_owner';
const ADMIN = 'user_admin';
const ENV = 'env_1';
const NOW = Date.parse('2026-09-09T12:00:00.000Z');

const FRAME = { type: 'grant_exec' as const, cmd: 'sh', args: ['-c', 'git status'], cwd: '/home/o/proj', env: { CI: '1' } };
const PRINCIPAL = { userId: OWNER, sessionId: 'sess_1', conversationId: 'conv_1' };
const REQUEST = { op: 'exec' as const, cmd: 'sh', args: ['-c', 'git status'], cwd: '/home/o/proj', paths: [], env: { CI: '1' }, timeoutMs: 120_000, maxBytes: 1_048_576, clamped: false };

function pendingEntry(over: Partial<PendingEnvApproval> = {}): PendingEnvApproval {
  return { challengeId: 'ch_1', envId: ENV, frame: FRAME, principal: PRINCIPAL, expiresAt: NOW + 30_000, pending: { challengeId: 'ch_1', expiresAt: NOW + 30_000, request: REQUEST }, createdAt: NOW, ...over };
}

const ctx = (challengeId = 'ch_1') => ({ params: Promise.resolve({ challengeId }) });
const post = (body: unknown, challengeId = 'ch_1') => POST(new Request(`http://localhost/api/env-bridge/approvals/${challengeId}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), ctx(challengeId));
const get = (challengeId = 'ch_1') => GET(new Request(`http://localhost/api/env-bridge/approvals/${challengeId}`), ctx(challengeId));
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

let sendGrant: ReturnType<typeof vi.fn>;
let sibling: { envId: string; ownerId: string; revokedAt: Date | null } | null;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isLocalEnvsEnabled).mockReturnValue(true);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetPendingApprovalStoreForTesting();
  sibling = { envId: ENV, ownerId: OWNER, revokedAt: null };
  vi.mocked(getDriveEnvStore).mockResolvedValue({ findLocalByEnvId: vi.fn(async () => sibling) } as never);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: OWNER } as never);
  sendGrant = vi.fn(async () => ({ type: 'exec_result', grantId: 'g_click', exitCode: 0, stdoutB64: Buffer.from('On branch main').toString('base64'), stderrB64: '', truncated: false, sig: 'c2ln' }));
  vi.mocked(getEnvBridgeClient).mockReturnValue({ sendGrant } as never);
  getPendingApprovalStore().remember(pendingEntry(), NOW);
});

describe('GET — the owner sees the frozen request verbatim', () => {
  it('given the owner, should answer the frozen request, principal and expiry exactly as the machine signed them', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ challengeId: 'ch_1', envId: ENV, principal: PRINCIPAL, expiresAt: NOW + 30_000, request: REQUEST, scopes: ['once', 'session', '30d', 'until_revoked'] });
  });

  it('given a drive ADMIN who is not the env owner, should refuse 403 not_owner and audit (D-6)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: ADMIN } as never);
    const r = await get();
    expect(r.status).toBe(403);
    expect(await json(r)).toMatchObject({ outcome: 'not_owner', ownerId: OWNER });
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', userId: ADMIN, resourceId: ENV }));
  });

  it('given an unknown id, should answer 410 approval_expired', async () => {
    expect((await get('ch_nope')).status).toBe(410);
  });

  it('given LOCAL_ENVS_ENABLED off, should 404 and touch nothing', async () => {
    vi.mocked(isLocalEnvsEnabled).mockReturnValue(false);
    expect((await get()).status).toBe(404);
    expect(authenticateRequestWithOptions).not.toHaveBeenCalled();
  });
});

describe('POST allow — the click re-issues a grant over IDENTICAL args carrying a server-signed approvalIntent', () => {
  it('given the owner clicks Allow with a scope, should send the SAME frame under the SAME principal with approvalIntent { challengeId, scope, expiresAt } and answer the command\'s outcome', async () => {
    const r = await post({ decision: 'allow', scope: 'until_revoked' });
    expect(r.status).toBe(200);
    expect(sendGrant).toHaveBeenCalledTimes(1);
    expect(sendGrant).toHaveBeenCalledWith({ envId: ENV, frame: FRAME, principal: PRINCIPAL, approvalIntent: { challengeId: 'ch_1', scope: 'until_revoked', expiresAt: NOW + 30_000 } });
    expect(await json(r)).toEqual({ challengeId: 'ch_1', outcome: 'allowed', scope: 'until_revoked', exitCode: 0, stdout: 'On branch main', stderr: '', truncated: false });
    // Spent: a second click on the same id is gone.
    expect((await post({ decision: 'allow' })).status).toBe(410);
    expect(sendGrant).toHaveBeenCalledTimes(1);
  });

  it('Codex P1 on #2583: a LARGE successful output (300 KiB stdout) is truncated to the tool output bounds so the result still validates against requestEnvApprovalOutputSchema, with truncated: true', async () => {
    const big = 'x'.repeat(300 * 1024);
    sendGrant.mockResolvedValueOnce({ type: 'exec_result', grantId: 'g', exitCode: 0, stdoutB64: Buffer.from(big).toString('base64'), stderrB64: Buffer.from('e'.repeat(60 * 1024)).toString('base64'), truncated: false, sig: 'c2ln' });
    const r = await post({ decision: 'allow' });
    expect(r.status).toBe(200);
    const body = await json(r);
    const parsed = requestEnvApprovalOutputSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues[0])).toBe(true);
    expect((body.stdout as string).length).toBe(ENV_APPROVAL_STDOUT_MAX_CHARS);
    expect((body.stderr as string).length).toBe(ENV_APPROVAL_STDERR_MAX_CHARS);
    expect(body.truncated).toBe(true);
    // Under the bound: untouched, and truncated stays what the machine said.
    sendGrant.mockResolvedValueOnce({ type: 'exec_result', grantId: 'g', exitCode: 0, stdoutB64: Buffer.from('small').toString('base64'), stderrB64: '', truncated: false, sig: 'c2ln' });
    resetPendingApprovalStoreForTesting();
    getPendingApprovalStore().remember(pendingEntry(), NOW);
    const small = await json(await post({ decision: 'allow' }));
    expect(small).toMatchObject({ stdout: 'small', truncated: false });
  });

  it('given no scope, should default to 30d', async () => {
    await post({ decision: 'allow' });
    expect(sendGrant).toHaveBeenCalledWith(expect.objectContaining({ approvalIntent: expect.objectContaining({ scope: '30d' }) }));
  });

  it('given the clicker is NOT drive_env_local.ownerId (a drive admin), should refuse 403, send NOTHING to the machine, keep the question pending, and audit', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: ADMIN } as never);
    const r = await post({ decision: 'allow' });
    expect(r.status).toBe(403);
    expect(await json(r)).toMatchObject({ outcome: 'not_owner', reason: 'not_owner' });
    expect(sendGrant).not.toHaveBeenCalled();
    expect(getPendingApprovalStore().size()).toBe(1);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', userId: ADMIN }));
  });

  it('given the click arrives after the challenge TTL, should answer 410 approval_expired and send nothing — the agent must request again', async () => {
    vi.setSystemTime(NOW + 30_001);
    const r = await post({ decision: 'allow' });
    expect(r.status).toBe(410);
    expect(await json(r)).toMatchObject({ outcome: 'expired', reason: 'approval_expired' });
    expect(sendGrant).not.toHaveBeenCalled();
  });

  it('given the MACHINE answers approval_mismatch / approval_expired / any other refusal, should relay the typed outcome (never 200 allowed)', async () => {
    for (const [reason, outcome, status] of [['approval_mismatch', 'mismatch', 409], ['approval_expired', 'expired', 410], ['declined', 'failed', 409]] as const) {
      resetPendingApprovalStoreForTesting();
      getPendingApprovalStore().remember(pendingEntry(), NOW);
      sendGrant.mockResolvedValueOnce({ type: 'grant_denied', grantId: 'g', reason, sig: 'c2ln' });
      const r = await post({ decision: 'allow' });
      expect(r.status, reason).toBe(status);
      expect(await json(r)).toMatchObject({ outcome, error: reason });
    }
  });

  it('given the bridge throws (no socket, refused to sign), should answer 502 failed with the typed kind', async () => {
    sendGrant.mockRejectedValueOnce(new EnvBridgeError('not_connected', 'gone'));
    const r = await post({ decision: 'allow' });
    expect(r.status).toBe(502);
    expect(await json(r)).toMatchObject({ outcome: 'failed', error: 'not_connected' });
  });

  it('given a revoked env, should 404 and drop the pending question', async () => {
    sibling = { envId: ENV, ownerId: OWNER, revokedAt: new Date(NOW) };
    expect((await post({ decision: 'allow' })).status).toBe(404);
    expect(getPendingApprovalStore().size()).toBe(0);
  });

  it('given a malformed body, should 400 without touching the store', async () => {
    expect((await post({ decision: 'maybe' })).status).toBe(400);
    expect((await post({ decision: 'allow', scope: 'forever' })).status).toBe(400);
    expect(getPendingApprovalStore().size()).toBe(1);
  });
});

describe('POST deny', () => {
  it('given the owner clicks Deny, should spend the question, send nothing, audit, and answer denied', async () => {
    const r = await post({ decision: 'deny' });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ challengeId: 'ch_1', outcome: 'denied' });
    expect(sendGrant).not.toHaveBeenCalled();
    expect(getPendingApprovalStore().size()).toBe(0);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.write', details: expect.objectContaining({ operation: 'deny', challengeId: 'ch_1' }) }));
  });
});

describe('GA wave 3 · leaf 5 — the MIRROR: a click that ran is recorded for visibility, never for allow', () => {
  it('given Allow with a durable scope and the machine ran it, should mirror the approval under the challenge id with the env, the clicker, the op, a readable summary, the scope and its expiry', async () => {
    const r = await post({ decision: 'allow', scope: '30d' });
    expect(r.status).toBe(200);
    expect(rememberEnvApproval).toHaveBeenCalledTimes(1);
    expect(rememberEnvApproval).toHaveBeenCalledWith(expect.objectContaining({ id: 'ch_1', envId: ENV, userId: OWNER, op: 'exec', scope: '30d', summary: "exec: sh -c git status in /home/o/proj", createdAt: new Date(NOW) }));
    const call = vi.mocked(rememberEnvApproval).mock.calls[0]![0];
    expect(call.expiresAt?.getTime()).toBe(NOW + 30 * 24 * 60 * 60 * 1000);
  });

  it('given until_revoked, the mirror row never expires; given session, it carries no expiry either (the daemon process is its life)', async () => {
    await post({ decision: 'allow', scope: 'until_revoked' });
    expect(vi.mocked(rememberEnvApproval).mock.calls[0]![0].expiresAt).toBeNull();
  });

  it('given once, deny, or a machine answer that is not allowed (mismatch / expired / denied), NOTHING is mirrored — the machine remembered nothing', async () => {
    await post({ decision: 'allow', scope: 'once' });
    getPendingApprovalStore().remember(pendingEntry(), NOW);
    await post({ decision: 'deny' });
    getPendingApprovalStore().remember(pendingEntry(), NOW);
    sendGrant.mockResolvedValueOnce({ type: 'grant_denied', grantId: 'g', reason: 'approval_mismatch', sig: 'c2ln' });
    await post({ decision: 'allow', scope: '30d' });
    expect(rememberEnvApproval).not.toHaveBeenCalled();
  });

  it('a mirror write that fails does not change the click\'s answer (the machine already ran it)', async () => {
    vi.mocked(rememberEnvApproval).mockRejectedValueOnce(new Error('db down'));
    const r = await post({ decision: 'allow', scope: '30d' });
    expect(r.status).toBe(200);
  });
});
