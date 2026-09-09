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
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({ getDriveEnvStore: vi.fn(), rememberEnvApproval: vi.fn(async () => null), getApprovalMirrorStore: vi.fn(), markEnvApprovalRevoked: vi.fn(async () => null), markEnvApprovalAcknowledged: vi.fn(async () => null) }));
vi.mock('@/lib/env-bridge/revoke', () => ({ revokeLocalEnvApproval: vi.fn() }));
vi.mock('@/lib/auth/permissions', () => ({ isPrincipalDriveOwnerOrAdmin: vi.fn(async () => true) }));
vi.mock('@/lib/env-bridge/bridge-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env-bridge/bridge-client')>();
  return { ...actual, getEnvBridgeClient: vi.fn() };
});

import { GET, POST, DELETE } from '../[challengeId]/route';
import { deriveOwnerApprovalChallenge } from '@pagespace/lib/env-bridge/owner-approval';
import { envBridgeSha256 } from '@/lib/env-bridge/crypto';

/** What the machine pinned at enrolment (hardening B, leaf B1) — the card may only offer these. */
const PINNED = { rpId: 'pagespace.test', origin: 'https://pagespace.test', credentials: [{ credentialId: 'cred-a', publicKeyCose: 'cose-a' }] };
import { revokeLocalEnvApproval } from '@/lib/env-bridge/revoke';
import { getApprovalMirrorStore, markEnvApprovalAcknowledged, markEnvApprovalRevoked, rememberEnvApproval } from '@/lib/drive-envs/drive-envs-runtime';
import { ENV_APPROVAL_STDERR_MAX_CHARS, ENV_APPROVAL_STDOUT_MAX_CHARS, requestEnvApprovalOutputSchema } from '@/lib/ai/tools/env-approval-tools';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { getDriveEnvStore } from '@/lib/drive-envs/drive-envs-runtime';
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
type Sibling = { envId: string; ownerId: string; revokedAt: Date | null; ownerCredentials: { rpId: string; origin: string; credentials: { credentialId: string; publicKeyCose: string }[] } | null };
let sibling: Sibling | null;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isLocalEnvsEnabled).mockReturnValue(true);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetPendingApprovalStoreForTesting();
  sibling = { envId: ENV, ownerId: OWNER, revokedAt: null, ownerCredentials: PINNED };
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
    expect(await json(r)).toEqual({
      challengeId: 'ch_1',
      envId: ENV,
      principal: PRINCIPAL,
      expiresAt: NOW + 30_000,
      request: REQUEST,
      scopes: ['once', 'session', '30d', 'until_revoked'],
      webauthn: {
        available: true,
        rpId: 'pagespace.test',
        // DERIVED from the frozen request, never random (hardening B, leaf B2) — the daemon recomputes the same value from the request IT froze.
        // One per SCOPE, because the challenge binds the scope and the owner chooses it on the card, after this response.
        challenges: {
          once: deriveOwnerApprovalChallenge({ envId: ENV, challengeId: 'ch_1', request: REQUEST, scope: 'once' }, envBridgeSha256),
          session: deriveOwnerApprovalChallenge({ envId: ENV, challengeId: 'ch_1', request: REQUEST, scope: 'session' }, envBridgeSha256),
          '30d': deriveOwnerApprovalChallenge({ envId: ENV, challengeId: 'ch_1', request: REQUEST, scope: '30d' }, envBridgeSha256),
          until_revoked: deriveOwnerApprovalChallenge({ envId: ENV, challengeId: 'ch_1', request: REQUEST, scope: 'until_revoked' }, envBridgeSha256),
        },
        allowCredentials: [{ id: 'cred-a', type: 'public-key' }],
      },
    });
  });

  it('the challenge is bound to THIS question, THIS request and THAT scope — changing any of them changes it', async () => {
    const body = await json(await get());
    const { challenges } = body.webauthn as { challenges: Record<string, string> };
    expect(challenges['30d']).not.toBe(deriveOwnerApprovalChallenge({ envId: ENV, challengeId: 'ch_other', request: REQUEST, scope: '30d' }, envBridgeSha256));
    expect(challenges['30d']).not.toBe(deriveOwnerApprovalChallenge({ envId: ENV, challengeId: 'ch_1', request: { ...REQUEST, cwd: '/elsewhere' }, scope: '30d' }, envBridgeSha256));
    // Every scope is distinct, so a proof for one can never authorise another (Codex P1 on #2599).
    expect(new Set(Object.values(challenges)).size).toBe(4);
  });

  it('given the machine pinned NO passkey, should say the ceremony is unavailable rather than offer credentials the daemon would refuse', async () => {
    sibling = { ...sibling!, ownerCredentials: { ...PINNED, credentials: [] } };
    expect((await json(await get())).webauthn).toMatchObject({ available: false, allowCredentials: [] });
    sibling = { ...sibling!, ownerCredentials: null };
    expect((await json(await get())).webauthn).toMatchObject({ available: false, rpId: null, allowCredentials: [] });
  });

  it('given a pending WRITE, should pass the machine\'s per-file findings through verbatim so the card can say which file and why (A7)', async () => {
    const files = [
      { path: '/home/o/proj/src/a.ts', mode: null, bytes: 3, reason: null },
      { path: '/home/o/proj/.git/hooks/pre-commit', mode: 0o755, bytes: 12, reason: 'vcs_metadata' as const },
    ];
    const writeRequest = { op: 'fs_write' as const, cwd: '/home/o/proj', paths: files.map((file) => file.path), writeModes: [null, 0o755], env: {}, timeoutMs: 120_000, maxBytes: 1_048_576, clamped: false };
    resetPendingApprovalStoreForTesting();
    getPendingApprovalStore().remember(pendingEntry({ pending: { challengeId: 'ch_1', expiresAt: NOW + 30_000, request: writeRequest, files } }), NOW);
    const body = await json(await get());
    expect(body.request).toEqual(writeRequest);
    expect(body.files).toEqual(files);
  });

  it('given a pending EXEC, should not invent a files key', async () => {
    expect(await json(await get())).not.toHaveProperty('files');
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
    // No assertion sent ⇒ none relayed: the ROUTE never invents one, and the machine is what refuses the unproven click.
    expect(JSON.stringify(sendGrant.mock.calls[0])).not.toContain('assertion');
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
    sibling = { envId: ENV, ownerId: OWNER, revokedAt: new Date(NOW), ownerCredentials: PINNED };
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

  it('given until_revoked, the mirror row never expires; given session, it carries no expiry but the env\'s current daemon epoch (Codex P2 #7) — its life is that process', async () => {
    await post({ decision: 'allow', scope: 'until_revoked' });
    expect(vi.mocked(rememberEnvApproval).mock.calls[0]![0]).toMatchObject({ expiresAt: null, daemonEpoch: null });
    getPendingApprovalStore().remember(pendingEntry(), NOW);
    sibling = { ...sibling!, daemonEpoch: 'ep_live' } as typeof sibling;
    await post({ decision: 'allow', scope: 'session' });
    expect(vi.mocked(rememberEnvApproval).mock.calls[1]![0]).toMatchObject({ scope: 'session', expiresAt: null, daemonEpoch: 'ep_live' });
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

describe('Codex P1 #5 (review round 1) — DELETE /api/env-bridge/approvals/[approvalId] is OWNER-scoped, never drive-scoped: an owner who left the drive can still revoke; a drive admin who is not the owner cannot', () => {
  const del = (id = 'ch_1') => DELETE(new Request(`http://localhost/api/env-bridge/approvals/${id}`, { method: 'DELETE' }), ctx(id));
  beforeEach(() => {
    vi.mocked(getApprovalMirrorStore).mockResolvedValue({ findById: vi.fn(async (id: string) => (id === 'ch_1' ? { id: 'ch_1', envId: ENV, userId: OWNER } : null)) } as never);
    vi.mocked(revokeLocalEnvApproval).mockResolvedValue({ ok: true, machine: { kind: 'acknowledged', removed: 2 } } as never);
  });

  it('given the machine OWNER (no drive membership consulted at all), should revoke through the same signed path, stamp the mirror, audit, and answer the machine\'s ack', async () => {
    const r = await del();
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ revoked: true, machine: 'acknowledged', approvalId: 'ch_1', removed: 2 });
    expect(revokeLocalEnvApproval).toHaveBeenCalledWith({ envId: ENV, approvalId: 'ch_1', reason: `revoked_by_${OWNER}` });
    expect(markEnvApprovalRevoked).toHaveBeenCalledWith({ id: 'ch_1', by: OWNER });
    expect(markEnvApprovalAcknowledged).toHaveBeenCalledWith({ id: 'ch_1', removed: 2 });
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.write', userId: OWNER, resourceId: ENV, details: expect.objectContaining({ route: 'env-bridge/approvals', operation: 'revoke', approvalId: 'ch_1' }) }));
  });

  it('given a drive ADMIN who did not enrol the machine, should refuse 403 not_owner naming the owner, audit, and revoke nothing — drive administration buys nothing here', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: ADMIN } as never);
    const r = await del();
    expect(r.status).toBe(403);
    expect(await json(r)).toMatchObject({ reason: 'not_owner', ownerId: OWNER });
    expect(revokeLocalEnvApproval).not.toHaveBeenCalled();
    expect(markEnvApprovalRevoked).not.toHaveBeenCalled();
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', userId: ADMIN }));
  });

  it('unacknowledged ⇒ 202 (decision stamped, ack not); no live socket ⇒ 409 (decision stamped); unknown approval ⇒ 404; flag off ⇒ 404', async () => {
    vi.mocked(revokeLocalEnvApproval).mockResolvedValueOnce({ ok: true, machine: { kind: 'unacknowledged', reason: 'timeout' } } as never);
    expect((await del()).status).toBe(202);
    vi.mocked(revokeLocalEnvApproval).mockResolvedValueOnce({ ok: true, machine: { kind: 'no_live_socket' } } as never);
    expect((await del()).status).toBe(409);
    expect(markEnvApprovalRevoked).toHaveBeenCalledTimes(2);
    expect(markEnvApprovalAcknowledged).not.toHaveBeenCalled();
    expect((await del('ch_nope')).status).toBe(404);
    vi.mocked(isLocalEnvsEnabled).mockReturnValue(false);
    expect((await del()).status).toBe(404);
  });
});

/**
 * B3 — the owner's WebAuthn assertion is RELAYED to the machine inside the
 * approval intent. The server does not verify it and must not: the party that
 * has to be convinced a human clicked is the machine.
 */
describe('POST allow — the assertion rides to the machine, unexamined', () => {
  const ASSERTION = { credentialId: 'cred-a', authenticatorData: 'YXV0aA', clientDataJSON: 'Y2xpZW50', signature: 'c2ln' };

  it('should pass the assertion through INTACT, inside approvalIntent, where the grant signature covers it', async () => {
    await post({ decision: 'allow', scope: 'once', assertion: ASSERTION });
    expect(sendGrant).toHaveBeenCalledWith({ envId: ENV, frame: FRAME, principal: PRINCIPAL, approvalIntent: { challengeId: 'ch_1', scope: 'once', expiresAt: NOW + 30_000, assertion: ASSERTION } });
  });

  it('should NOT verify-and-discard it as the step-up flow does — a byte the machine needs must reach the machine', async () => {
    // An assertion that could not possibly verify anywhere still travels: judging it here would be the server attestation this change removes.
    const junk = { ...ASSERTION, signature: 'AAAA' };
    await post({ decision: 'allow', assertion: junk });
    expect(sendGrant).toHaveBeenCalledWith(expect.objectContaining({ approvalIntent: expect.objectContaining({ assertion: junk }) }));
  });

  it.each<[string, unknown]>([
    ['a non-object', 'nope'],
    ['a missing signature', { credentialId: 'a', authenticatorData: 'b', clientDataJSON: 'c' }],
    ['an extra field', { credentialId: 'a', authenticatorData: 'b', clientDataJSON: 'c', signature: 'd', isAdmin: true }],
  ])('given a MALFORMED assertion (%s), should 400 and send nothing — the strict body schema was opened on purpose, not loosened', async (_label, assertion) => {
    const r = await post({ decision: 'allow', assertion });
    expect(r.status).toBe(400);
    expect(sendGrant).not.toHaveBeenCalled();
  });

  it('Deny needs no assertion — refusing to run is never the dangerous direction', async () => {
    const r = await post({ decision: 'deny' });
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ outcome: 'denied' });
    expect(sendGrant).not.toHaveBeenCalled();
  });
});
