/**
 * Contract tests for `/api/drives/[driveId]/envs/**`.
 *
 * Mocked at the SERVICE SEAM (the drive-envs runtime), not the ORM: what these
 * assert is the route's own contract — who is let through which verb, how a
 * service result becomes a status code, and the two guards that live in the
 * route rather than in the service (the env-belongs-to-this-drive check and the
 * `?force=` parse).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(() => false),
  checkMCPDriveScope: vi.fn().mockReturnValue(null),
  isPrincipalDriveMember: vi.fn(),
  isPrincipalDriveOwnerOrAdmin: vi.fn(),
}));
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({
  createEnvInDrive: vi.fn(),
  listEnvsInDrive: vi.fn(),
  renameEnv: vi.fn(),
  deleteEnv: vi.fn(),
  rebuildEnv: vi.fn(),
  resolveEnvInDrive: vi.fn(),
  toDriveEnvDTO: vi.fn((row: { id: string; driveId: string; name: string }) => ({
    id: row.id,
    driveId: row.driveId,
    name: row.name,
    status: 'none',
    createdAt: '2026-08-17T12:00:00.000Z',
  })),
}));

import { GET as listEnvs, POST as createEnv } from '../route';
import { GET as readEnv, PATCH as patchEnv, DELETE as deleteEnvRoute } from '../[envId]/route';
import { POST as rebuildEnvRoute } from '../[envId]/rebuild/route';
import { isPrincipalDriveMember, isPrincipalDriveOwnerOrAdmin, authenticateRequestWithOptions } from '@/lib/auth';
import {
  createEnvInDrive,
  deleteEnv,
  listEnvsInDrive,
  rebuildEnv,
  renameEnv,
  resolveEnvInDrive,
} from '@/lib/drive-envs/drive-envs-runtime';

const DRIVE_ID = 'drive-1';
const ENV_ID = 'env-1';
const USER_ID = 'user-1';

const params = { params: Promise.resolve({ driveId: DRIVE_ID }) };
const envParams = { params: Promise.resolve({ driveId: DRIVE_ID, envId: ENV_ID }) };

function req(url = `http://localhost/api/drives/${DRIVE_ID}/envs`, init?: RequestInit): Request {
  return new Request(url, init);
}

function jsonReq(body: unknown, url = `http://localhost/api/drives/${DRIVE_ID}/envs`): Request {
  return new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

const envRow = { id: ENV_ID, driveId: DRIVE_ID, name: 'staging' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: USER_ID } as never);
  vi.mocked(isPrincipalDriveMember).mockResolvedValue(true);
  vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(true);
  vi.mocked(resolveEnvInDrive).mockResolvedValue(envRow as never);
});

describe('GET /envs — who may SEE a drive"s machines', () => {
  it('given an accepted member, should list', async () => {
    vi.mocked(listEnvsInDrive).mockResolvedValue([]);
    const response = await listEnvs(req(), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ envs: [] });
  });

  it('given a non-member, should refuse — membership, not mere authentication', async () => {
    vi.mocked(isPrincipalDriveMember).mockResolvedValue(false);
    const response = await listEnvs(req(), params);
    expect(response.status).toBe(403);
    expect(listEnvsInDrive).not.toHaveBeenCalled();
  });
});

describe('POST /envs — who may CREATE one', () => {
  it('given a plain MEMBER, should refuse — an env is drive infrastructure', async () => {
    // Deliberately NOT the read gate: seeing a machine and administering one
    // are different authorities, and a member passes the first.
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(false);
    const response = await createEnv(jsonReq({ name: 'staging' }), params);
    expect(response.status).toBe(403);
    expect(createEnvInDrive).not.toHaveBeenCalled();
  });

  it('given an admin and a valid name, should create and answer 201', async () => {
    vi.mocked(createEnvInDrive).mockResolvedValue({ ok: true, env: envRow } as never);
    const response = await createEnv(jsonReq({ name: '  staging  ' }), params);
    expect(response.status).toBe(201);
    // Trimmed at the boundary: `(driveId, name)` uniqueness makes the name an
    // address, so ' staging ' and 'staging' must not become two envs.
    expect(createEnvInDrive).toHaveBeenCalledWith({ driveId: DRIVE_ID, name: 'staging', createdBy: USER_ID });
  });

  it('given a blank name, should answer 400 without touching the service', async () => {
    const response = await createEnv(jsonReq({ name: '   ' }), params);
    expect(response.status).toBe(400);
    expect(createEnvInDrive).not.toHaveBeenCalled();
  });

  it('given substrate local, should answer 501 and NOT create anything — enrollment lands in a later slice, and a Sprite env must never be minted in its place (Local Environments t05)', async () => {
    const response = await createEnv(jsonReq({ name: 'mac', substrate: 'local', label: 'jono-macstudio' }), params);
    expect(response.status).toBe(501);
    expect(createEnvInDrive).not.toHaveBeenCalled();
  });

  it('given substrate local without a label, should answer 400 naming the label, not the name', async () => {
    const response = await createEnv(jsonReq({ name: 'mac', substrate: 'local' }), params);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/label/i);
    expect(createEnvInDrive).not.toHaveBeenCalled();
  });

  it('given an explicit substrate sprite, should behave exactly like the plain-name path', async () => {
    vi.mocked(createEnvInDrive).mockResolvedValue({ ok: true, env: envRow } as never);
    const response = await createEnv(jsonReq({ name: 'dev', substrate: 'sprite' }), params);
    expect(response.status).toBe(201);
    expect(createEnvInDrive).toHaveBeenCalledWith({ driveId: DRIVE_ID, name: 'dev', createdBy: USER_ID });
  });

  it('given a duplicate name, should answer 409', async () => {
    vi.mocked(createEnvInDrive).mockResolvedValue({ ok: false, reason: 'name_taken' } as never);
    const response = await createEnv(jsonReq({ name: 'staging' }), params);
    expect(response.status).toBe(409);
  });

  it('given the payer is at their ceiling, should answer 402 and name the limit', async () => {
    vi.mocked(createEnvInDrive).mockResolvedValue({
      ok: false,
      reason: 'quota_exceeded',
      denial: 'env_limit_reached',
      limit: 2,
    } as never);
    const response = await createEnv(jsonReq({ name: 'staging' }), params);
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ reason: 'env_limit_reached', limit: 2 });
  });

  it('given an ineligible tier, should answer 403 — a forbidden feature, not a reached ceiling', async () => {
    vi.mocked(createEnvInDrive).mockResolvedValue({
      ok: false,
      reason: 'quota_exceeded',
      denial: 'tier_ineligible',
      limit: 0,
    } as never);
    const response = await createEnv(jsonReq({ name: 'staging' }), params);
    expect(response.status).toBe(403);
  });
});

describe('the env-belongs-to-this-drive guard', () => {
  it('given an env id from ANOTHER drive, should answer 404 on read — never 403, which would confirm it exists', async () => {
    vi.mocked(resolveEnvInDrive).mockResolvedValue(null);
    const response = await readEnv(req(), envParams);
    expect(response.status).toBe(404);
  });

  it('given an env id from another drive, should answer 404 on delete WITHOUT deleting', async () => {
    vi.mocked(resolveEnvInDrive).mockResolvedValue(null);
    const response = await deleteEnvRoute(
      req(`http://localhost/api/drives/${DRIVE_ID}/envs/${ENV_ID}`, { method: 'DELETE' }),
      envParams,
    );
    expect(response.status).toBe(404);
    expect(deleteEnv).not.toHaveBeenCalled();
  });
});

describe('PATCH /envs/[envId] — rename', () => {
  it('given a plain member, should refuse', async () => {
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(false);
    const response = await patchEnv(jsonReq({ name: 'prod' }), envParams);
    expect(response.status).toBe(403);
    expect(renameEnv).not.toHaveBeenCalled();
  });

  it('given a taken name, should answer 409', async () => {
    vi.mocked(renameEnv).mockResolvedValue({ ok: false, reason: 'name_taken' } as never);
    const response = await patchEnv(jsonReq({ name: 'prod' }), envParams);
    expect(response.status).toBe(409);
  });

  it('given an admin and a free name, should rename', async () => {
    vi.mocked(renameEnv).mockResolvedValue({ ok: true, env: { ...envRow, name: 'prod' } } as never);
    const response = await patchEnv(jsonReq({ name: 'prod' }), envParams);
    expect(response.status).toBe(200);
    expect(renameEnv).toHaveBeenCalledWith({ envId: ENV_ID, name: 'prod' });
  });
});

describe('DELETE /envs/[envId] — the destructive verb', () => {
  function del(query = ''): Request {
    return req(`http://localhost/api/drives/${DRIVE_ID}/envs/${ENV_ID}${query}`, { method: 'DELETE' });
  }

  it('should NOT force by default', async () => {
    vi.mocked(deleteEnv).mockResolvedValue({ ok: true, spriteTornDown: false } as never);
    await deleteEnvRoute(del(), envParams);
    expect(deleteEnv).toHaveBeenCalledWith({ envId: ENV_ID, force: false });
  });

  it('given ?force=true, should force', async () => {
    vi.mocked(deleteEnv).mockResolvedValue({ ok: true, spriteTornDown: true } as never);
    await deleteEnvRoute(del('?force=true'), envParams);
    expect(deleteEnv).toHaveBeenCalledWith({ envId: ENV_ID, force: true });
  });

  it('given a bare or non-"true" force flag, should NOT force — a stray query must not destroy shared work', async () => {
    vi.mocked(deleteEnv).mockResolvedValue({ ok: true, spriteTornDown: false } as never);
    await deleteEnvRoute(del('?force'), envParams);
    await deleteEnvRoute(del('?force=1'), envParams);
    await deleteEnvRoute(del('?force=TRUE'), envParams);
    for (const call of vi.mocked(deleteEnv).mock.calls) expect(call[0]).toEqual({ envId: ENV_ID, force: false });
  });

  it('given live sessions, should answer 409 and report the count', async () => {
    vi.mocked(deleteEnv).mockResolvedValue({ ok: false, reason: 'live_sessions', liveSessionCount: 3 } as never);
    const response = await deleteEnvRoute(del(), envParams);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'live_sessions', liveSessionCount: 3 });
  });

  it('given a kill that could not be confirmed, should still answer 200 — the env IS deleted', async () => {
    // There is no `teardown_failed` arm any more, and that is a deliberate
    // consequence of killing the Sprite only AFTER the row is gone: by the time
    // a kill can fail, the delete has already committed and the reclaim outbox
    // owns the retry. Reporting 503 here would tell the client to retry a
    // destructive verb that already succeeded. `spriteTornDown: false` carries
    // the nuance instead — deleted, but this request did not stop the machine.
    vi.mocked(deleteEnv).mockResolvedValue({ ok: true, spriteTornDown: false } as never);
    const response = await deleteEnvRoute(del(), envParams);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, spriteTornDown: false });
  });

  it('given a plain member, should refuse before any delete is attempted', async () => {
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(false);
    const response = await deleteEnvRoute(del('?force=true'), envParams);
    expect(response.status).toBe(403);
    expect(deleteEnv).not.toHaveBeenCalled();
  });
});

describe('POST /envs/[envId]/rebuild — the only sprite-replacing verb', () => {
  const rebuildReq = () =>
    req(`http://localhost/api/drives/${DRIVE_ID}/envs/${ENV_ID}/rebuild`, { method: 'POST' });

  it('given a plain member, should refuse — rebuilding destroys a shared filesystem', async () => {
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(false);
    const response = await rebuildEnvRoute(rebuildReq(), envParams);
    expect(response.status).toBe(403);
    expect(rebuildEnv).not.toHaveBeenCalled();
  });

  it('given an admin, should rebuild AS that requester', async () => {
    vi.mocked(rebuildEnv).mockResolvedValue({ ok: true, sandboxId: 'pgs-env-abc' } as never);
    const response = await rebuildEnvRoute(rebuildReq(), envParams);
    expect(response.status).toBe(200);
    expect(rebuildEnv).toHaveBeenCalledWith({ envId: ENV_ID, requesterId: USER_ID });
  });

  it('given the teardown failed, should answer 503 and say so', async () => {
    vi.mocked(rebuildEnv).mockResolvedValue({ ok: false, reason: 'teardown_failed', detail: 'boom' } as never);
    const response = await rebuildEnvRoute(rebuildReq(), envParams);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: 'teardown_failed' });
  });
});
