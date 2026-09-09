/**
 * `GET /api/drives/[driveId]/envs/[envId]/activity` (GA wave 3, leaf 2) —
 * the machine OWNER reads what ran; a drive admin who did not enrol it is
 * refused and told who did ([D-6]); every read audited.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } } }));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(() => false),
  checkMCPDriveScope: vi.fn().mockReturnValue(null),
  isPrincipalDriveMember: vi.fn(),
}));
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({ resolveEnvInDrive: vi.fn(), getDriveEnvStore: vi.fn(), listEnvActivity: vi.fn() }));

import { GET } from '../route';
import { authenticateRequestWithOptions, isPrincipalDriveMember } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getDriveEnvStore, listEnvActivity, resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';

const DRIVE = 'drive-1';
const ENV = 'env-1';
const OWNER = 'user-owner';
const ADMIN = 'user-admin';
const ROW = { id: 'row-1', envId: ENV, grantId: 'g-1', userId: OWNER, sessionId: 's', conversationId: 'c', op: 'exec', summary: 'exec: ls', verdict: 'signed', exitCode: null, challengeId: null, approvalScope: null, ts: '2026-09-09T12:00:00.000Z', resultAt: null };

const ctx = { params: Promise.resolve({ driveId: DRIVE, envId: ENV }) };
const get = () => GET(new Request(`http://localhost/api/drives/${DRIVE}/envs/${ENV}/activity`), ctx);
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

let sibling: { envId: string; ownerId: string; revokedAt: Date | null } | null;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: OWNER } as never);
  vi.mocked(isPrincipalDriveMember).mockResolvedValue(true);
  vi.mocked(resolveEnvInDrive).mockResolvedValue({ id: ENV, driveId: DRIVE, name: 'mac', substrate: 'local' } as never);
  sibling = { envId: ENV, ownerId: OWNER, revokedAt: null };
  vi.mocked(getDriveEnvStore).mockResolvedValue({ findLocalByEnvId: vi.fn(async () => sibling) } as never);
  vi.mocked(listEnvActivity).mockResolvedValue([ROW] as never);
});

describe('who may see what ran on a machine', () => {
  it('given the machine OWNER, should answer the rows newest-first from the runtime seam and audit data.read on the env', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ activity: [ROW] });
    expect(listEnvActivity).toHaveBeenCalledWith({ envId: ENV, limit: 50 });
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.read', userId: OWNER, resourceType: 'drive_env', resourceId: ENV, details: expect.objectContaining({ route: 'drive-env-activity', rows: 1 }) }));
  });

  it('given a drive ADMIN who did not enrol the machine, should refuse 403 not_owner naming the owner, audit it, and read NO rows (D-6)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: ADMIN } as never);
    const r = await get();
    expect(r.status).toBe(403);
    const body = await json(r);
    expect(body).toMatchObject({ reason: 'not_owner', ownerId: OWNER });
    expect(String(body.error)).toContain(OWNER);
    expect(listEnvActivity).not.toHaveBeenCalled();
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', userId: ADMIN, resourceType: 'drive_env', resourceId: ENV, details: expect.objectContaining({ ownerId: OWNER }) }));
  });

  it('given a non-member, should refuse 403 before the env is resolved', async () => {
    vi.mocked(isPrincipalDriveMember).mockResolvedValue(false);
    expect((await get()).status).toBe(403);
    expect(resolveEnvInDrive).not.toHaveBeenCalled();
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', resourceType: 'drive' }));
  });

  it('given an env that is not in this drive, should answer 404', async () => {
    vi.mocked(resolveEnvInDrive).mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    expect(listEnvActivity).not.toHaveBeenCalled();
  });

  it('given a Sprite env, should answer 409 not_local — a cloud sandbox has no machine activity here', async () => {
    vi.mocked(resolveEnvInDrive).mockResolvedValue({ id: ENV, driveId: DRIVE, name: 'cloud', substrate: 'sprite' } as never);
    const r = await get();
    expect(r.status).toBe(409);
    expect(await json(r)).toMatchObject({ reason: 'not_local' });
  });

  it('given a dead local env (no sibling), should answer 404 — there is no owner to be', async () => {
    sibling = null;
    expect((await get()).status).toBe(404);
    expect(listEnvActivity).not.toHaveBeenCalled();
  });
});
