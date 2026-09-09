/**
 * GA wave 2, leaf 8 — DELETE one remembered approval: env owner or drive
 * admin, over the signed revoke frame, honest when the machine is not there.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }, logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(() => false),
  checkMCPDriveScope: vi.fn(() => null),
  isPrincipalDriveMember: vi.fn(async () => true),
  isPrincipalDriveOwnerOrAdmin: vi.fn(async () => false),
}));
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({ resolveEnvInDrive: vi.fn(), getDriveEnvStore: vi.fn() }));
vi.mock('@/lib/env-bridge/revoke', () => ({ revokeLocalEnvApproval: vi.fn() }));

import { DELETE } from '../[approvalId]/route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions, isPrincipalDriveMember, isPrincipalDriveOwnerOrAdmin } from '@/lib/auth';
import { getDriveEnvStore, resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';
import { revokeLocalEnvApproval } from '@/lib/env-bridge/revoke';

const DRIVE = 'drive_1';
const ENV = 'env_1';
const OWNER = 'user_owner';
const ADMIN = 'user_admin';
const MEMBER = 'user_member';

const call = (approvalId = 'ch_1') => DELETE(new Request(`http://localhost/api/drives/${DRIVE}/envs/${ENV}/approvals/${approvalId}`, { method: 'DELETE' }), { params: Promise.resolve({ driveId: DRIVE, envId: ENV, approvalId }) });
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isPrincipalDriveMember).mockResolvedValue(true);
  vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(false);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: OWNER } as never);
  vi.mocked(resolveEnvInDrive).mockResolvedValue({ id: ENV, driveId: DRIVE, substrate: 'local' } as never);
  vi.mocked(getDriveEnvStore).mockResolvedValue({ findLocalByEnvId: vi.fn(async () => ({ envId: ENV, ownerId: OWNER, revokedAt: null })) } as never);
  vi.mocked(revokeLocalEnvApproval).mockResolvedValue({ ok: true, machine: 'sent' });
});

describe('DELETE /api/drives/[driveId]/envs/[envId]/approvals/[approvalId]', () => {
  it('given the env OWNER (a plain member), should send the signed approval revoke and answer revoked', async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ revoked: true, machine: 'sent', approvalId: 'ch_1' });
    expect(revokeLocalEnvApproval).toHaveBeenCalledWith({ envId: ENV, approvalId: 'ch_1', reason: `revoked_by_${OWNER}` });
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.write', details: expect.objectContaining({ operation: 'revoke', approvalId: 'ch_1', machine: 'sent' }) }));
  });

  it('given a drive ADMIN who is not the owner, should ALSO revoke (Revoke stays with admins, D-6)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: ADMIN } as never);
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(true);
    expect((await call()).status).toBe(200);
  });

  it('given a plain member who is neither, should refuse 403, send nothing, and audit', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: MEMBER } as never);
    const r = await call();
    expect(r.status).toBe(403);
    expect(revokeLocalEnvApproval).not.toHaveBeenCalled();
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', userId: MEMBER }));
  });

  it('given a non-member, should 403 before any lookup', async () => {
    vi.mocked(isPrincipalDriveMember).mockResolvedValue(false);
    expect((await call()).status).toBe(403);
    expect(resolveEnvInDrive).not.toHaveBeenCalled();
  });

  it('given the machine is not connected, should answer 409 revoked:false with the reach outcome — never a claimed revoke', async () => {
    vi.mocked(revokeLocalEnvApproval).mockResolvedValue({ ok: true, machine: 'no_live_socket' });
    const r = await call();
    expect(r.status).toBe(409);
    expect(await json(r)).toMatchObject({ revoked: false, machine: 'no_live_socket' });
  });

  it('given an env outside the drive, a Sprite env, or a revoked env, should answer 404 / 409 / 409', async () => {
    vi.mocked(resolveEnvInDrive).mockResolvedValueOnce(null);
    expect((await call()).status).toBe(404);
    vi.mocked(resolveEnvInDrive).mockResolvedValueOnce({ id: ENV, driveId: DRIVE, substrate: 'sprite' } as never);
    expect((await call()).status).toBe(409);
    vi.mocked(revokeLocalEnvApproval).mockResolvedValueOnce({ ok: false, reason: 'revoked' });
    expect((await call()).status).toBe(409);
  });
});
