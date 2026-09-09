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
vi.mock('@pagespace/lib/services/drive-envs/local-envs-enabled', () => ({ isLocalEnvsEnabled: vi.fn(() => false) }));
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({
  createEnvInDrive: vi.fn(),
  listEnvsInDrive: vi.fn(),
  renameEnv: vi.fn(),
  readEnvDTO: vi.fn(async (row: { id: string; driveId: string; name: string; substrate?: string }) => ({ id: row.id, driveId: row.driveId, name: row.name, substrate: row.substrate ?? 'sprite', status: row.substrate === 'local' ? 'disconnected' : 'none', createdAt: '2026-08-17T12:00:00.000Z' })),
  setEnvServerPolicy: vi.fn(),
  setEnvPaused: vi.fn(),
  deleteEnv: vi.fn(),
  revokeEnv: vi.fn(),
  rebuildEnv: vi.fn(),
  reissueEnvEnrollmentCode: vi.fn(),
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
import { POST as reissueCodeRoute } from '../[envId]/enrollment-code/route';
import { isPrincipalDriveMember, isPrincipalDriveOwnerOrAdmin, authenticateRequestWithOptions } from '@/lib/auth';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import {
  createEnvInDrive,
  deleteEnv,
  listEnvsInDrive,
  rebuildEnv,
  reissueEnvEnrollmentCode,
  readEnvDTO,
  renameEnv,
  resolveEnvInDrive,
  revokeEnv,
  setEnvServerPolicy,
  setEnvPaused,
  toDriveEnvDTO,
} from '@/lib/drive-envs/drive-envs-runtime';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

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

  it('given substrate local while LOCAL_ENVS_ENABLED is off, should answer 501 and create NOTHING — never a Sprite env in its place', async () => {
    vi.mocked(isLocalEnvsEnabled).mockReturnValue(false);
    const response = await createEnv(jsonReq({ name: 'mac', substrate: 'local', label: 'jono-macstudio', serverPolicy: { ops: ['fs_read'], checkpoint: false } }), params);
    expect(response.status).toBe(501);
    expect(createEnvInDrive).not.toHaveBeenCalled();
  });

  it('given substrate local with the flag on, should create a local env owned by the caller and return the one-time enrollment code ONCE, with the env born disconnected', async () => {
    vi.mocked(isLocalEnvsEnabled).mockReturnValue(true);
    const expiresAt = new Date('2026-09-05T10:10:00.000Z');
    vi.mocked(createEnvInDrive).mockResolvedValue({
      ok: true,
      env: { ...envRow, name: 'mac', substrate: 'local' },
      enrollment: { enrollmentId: 'enr_1', code: 'ABCDEFGHJKMNPQRSTVWX', expiresAt },
    } as never);
    const response = await createEnv(jsonReq({ name: 'mac', substrate: 'local', label: 'jono-macstudio', serverPolicy: { ops: ['fs_read', 'fs_write'], checkpoint: false } }), params);
    expect(response.status).toBe(201);
    expect(createEnvInDrive).toHaveBeenCalledWith({
      driveId: DRIVE_ID,
      name: 'mac',
      createdBy: USER_ID,
      local: { label: 'jono-macstudio', ownerId: USER_ID, serverPolicy: { ops: ['fs_read', 'fs_write'], checkpoint: false } },
    });
    const body = (await response.json()) as { env: unknown; enrollment: { enrollmentId: string; code: string; expiresAt: string } };
    expect(body.enrollment).toEqual({ enrollmentId: 'enr_1', code: 'ABCDEFGHJKMNPQRSTVWX', expiresAt: expiresAt.toISOString() });
    // The DTO carries the policy that was just written, so the client never has to guess it — and a freshly
    // created env is the CALLER's machine, has advertised nothing, and is not paused (GA wave 3 facts).
    expect(toDriveEnvDTO).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ serverPolicy: { ops: ['fs_read', 'fs_write'], checkpoint: false }, ownerId: USER_ID, capabilities: null, paused: false }));
  });

  it('given substrate local WITHOUT a serverPolicy, should answer 400 naming the policy and mint NOTHING — never fall to the column default', async () => {
    vi.mocked(isLocalEnvsEnabled).mockReturnValue(true);
    const response = await createEnv(jsonReq({ name: 'mac', substrate: 'local', label: 'jono-macstudio' }), params);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/policy/i);
    expect(createEnvInDrive).not.toHaveBeenCalled();
  });

  it('given a serverPolicy with checkpoint true or an op outside the closed set, should answer 400 naming the policy', async () => {
    vi.mocked(isLocalEnvsEnabled).mockReturnValue(true);
    for (const serverPolicy of [{ ops: ['fs_read'], checkpoint: true }, { ops: ['pty_open', 'shell'], checkpoint: false }]) {
      const response = await createEnv(jsonReq({ name: 'mac', substrate: 'local', label: 'jono-macstudio', serverPolicy }), params);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(/policy/i);
    }
    expect(createEnvInDrive).not.toHaveBeenCalled();
  });

  it('given substrate local without a label, should answer 400 naming the label, not the name', async () => {
    const response = await createEnv(jsonReq({ name: 'mac', substrate: 'local', serverPolicy: { ops: [], checkpoint: false } }), params);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/label/i);
    expect(createEnvInDrive).not.toHaveBeenCalled();
  });

  it('given an unknown substrate, should answer 400 naming the substrate — not the name', async () => {
    const response = await createEnv(jsonReq({ name: 'dev', substrate: 'modal' }), params);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/substrate/i);
    expect(createEnvInDrive).not.toHaveBeenCalled();
  });

  it('given a blank label for a local env, should answer 400 naming the label as invalid (not merely missing)', async () => {
    const response = await createEnv(jsonReq({ name: 'mac', substrate: 'local', label: '   ', serverPolicy: { ops: [], checkpoint: false } }), params);
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

describe('GET /envs/[envId] on a LOCAL env — through the facts join, never the bare DTO (which throws for a local row)', () => {
  it('given a local env, should answer 200 with the joined DTO', async () => {
    vi.mocked(resolveEnvInDrive).mockResolvedValue({ ...envRow, substrate: 'local' } as never);
    const response = await readEnv(req(), envParams);
    expect(response.status).toBe(200);
    expect(readEnvDTO).toHaveBeenCalledWith(expect.objectContaining({ id: ENV_ID, substrate: 'local' }));
    expect(await response.json()).toMatchObject({ env: { id: ENV_ID, substrate: 'local', status: 'disconnected' } });
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

describe('PATCH /envs/[envId] — serverPolicy is OWNER-ONLY (D-6: the enrolling human, never a drive role)', () => {
  const localRow = { ...envRow, substrate: 'local' as const };
  const POLICY = { ops: ['fs_read', 'exec'], checkpoint: false };

  it('given the env OWNER (a plain drive MEMBER — no admin right needed), should set the policy, audit the write, and answer it back', async () => {
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(false);
    vi.mocked(resolveEnvInDrive).mockResolvedValue(localRow as never);
    vi.mocked(setEnvServerPolicy).mockResolvedValue({ ok: true, serverPolicy: POLICY } as never);
    const response = await patchEnv(jsonReq({ serverPolicy: POLICY }), envParams);
    expect(response.status).toBe(200);
    expect(setEnvServerPolicy).toHaveBeenCalledWith({ envId: ENV_ID, requesterId: USER_ID, serverPolicy: POLICY });
    expect(await response.json()).toMatchObject({ env: { id: ENV_ID, substrate: 'local' }, serverPolicy: POLICY });
    expect(renameEnv).not.toHaveBeenCalled();
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.write', details: expect.objectContaining({ operation: 'set_server_policy', envId: ENV_ID }) }));
  });

  it('given a drive ADMIN who did not enrol the machine, should refuse 403 naming the owner, audit it, and write nothing', async () => {
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(true);
    vi.mocked(resolveEnvInDrive).mockResolvedValue(localRow as never);
    vi.mocked(setEnvServerPolicy).mockResolvedValue({ ok: false, reason: 'not_owner', ownerId: 'user-owner' } as never);
    const response = await patchEnv(jsonReq({ serverPolicy: POLICY }), envParams);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; reason: string; ownerId: string };
    expect(body).toMatchObject({ reason: 'not_owner', ownerId: 'user-owner' });
    expect(body.error).toMatch(/owner/i);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', details: expect.objectContaining({ operation: 'set_server_policy', ownerId: 'user-owner' }) }));
  });

  it('given a revoked env, should answer 409', async () => {
    vi.mocked(resolveEnvInDrive).mockResolvedValue(localRow as never);
    vi.mocked(setEnvServerPolicy).mockResolvedValue({ ok: false, reason: 'revoked' } as never);
    const response = await patchEnv(jsonReq({ serverPolicy: POLICY }), envParams);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'revoked' });
  });

  it('given a SPRITE env, should answer 409 not_local without calling the service — a Sprite has no server policy', async () => {
    vi.mocked(resolveEnvInDrive).mockResolvedValue(envRow as never);
    const response = await patchEnv(jsonReq({ serverPolicy: POLICY }), envParams);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'not_local' });
    expect(setEnvServerPolicy).not.toHaveBeenCalled();
  });

  it('given a body with BOTH name and serverPolicy, or neither, or a malformed policy, should answer 400 and call nothing', async () => {
    vi.mocked(resolveEnvInDrive).mockResolvedValue(localRow as never);
    for (const body of [{ name: 'prod', serverPolicy: POLICY }, {}, { serverPolicy: { ops: ['exec'], checkpoint: true } }]) {
      const response = await patchEnv(jsonReq(body), envParams);
      expect(response.status).toBe(400);
    }
    expect(setEnvServerPolicy).not.toHaveBeenCalled();
    expect(renameEnv).not.toHaveBeenCalled();
  });

  it('given an env in another drive, should answer 404 without calling the service', async () => {
    vi.mocked(resolveEnvInDrive).mockResolvedValue(null);
    const response = await patchEnv(jsonReq({ serverPolicy: POLICY }), envParams);
    expect(response.status).toBe(404);
    expect(setEnvServerPolicy).not.toHaveBeenCalled();
  });
});

describe('PATCH /envs/[envId] — Stop / Resume (`paused`) is OWNER-ONLY too (GA wave 3, leaf 3; D-6: admins keep Delete, never Stop)', () => {
  const localRow = { ...envRow, substrate: 'local' as const };

  it('given the env OWNER (a plain member), Stop should pause through the service, audit `pause`, and answer the env with paused: true', async () => {
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(false);
    vi.mocked(resolveEnvInDrive).mockResolvedValue(localRow as never);
    vi.mocked(setEnvPaused).mockResolvedValue({ ok: true, paused: true, machine: { kind: 'acknowledged', killed: 1 } } as never);
    const response = await patchEnv(jsonReq({ paused: true }), envParams);
    expect(response.status).toBe(200);
    expect(setEnvPaused).toHaveBeenCalledWith({ envId: ENV_ID, requesterId: USER_ID, paused: true });
    expect(await response.json()).toMatchObject({ env: { id: ENV_ID, substrate: 'local' }, paused: true, machine: 'acknowledged', killed: 1 });
    expect(setEnvServerPolicy).not.toHaveBeenCalled();
    expect(renameEnv).not.toHaveBeenCalled();
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.write', userId: USER_ID, resourceType: 'drive_env', resourceId: ENV_ID, details: expect.objectContaining({ operation: 'pause', envId: ENV_ID }) }));
  });

  it('the MACHINE is reported honestly: unacknowledged ⇒ 202 (the pause went out, nothing proven), no_live_socket ⇒ 200 (the holder delivers within a ping) — never a stop the machine did not sign', async () => {
    vi.mocked(resolveEnvInDrive).mockResolvedValue(localRow as never);
    vi.mocked(setEnvPaused).mockResolvedValue({ ok: true, paused: true, machine: { kind: 'unacknowledged', reason: 'timeout' } } as never);
    const late = await patchEnv(jsonReq({ paused: true }), envParams);
    expect(late.status).toBe(202);
    expect(await late.json()).toMatchObject({ paused: true, machine: 'unacknowledged' });
    vi.mocked(setEnvPaused).mockResolvedValue({ ok: true, paused: true, machine: { kind: 'no_live_socket' } } as never);
    const elsewhere = await patchEnv(jsonReq({ paused: true }), envParams);
    expect(elsewhere.status).toBe(200);
    expect(await elsewhere.json()).toMatchObject({ paused: true, machine: 'no_live_socket' });
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.write', details: expect.objectContaining({ operation: 'pause', machine: 'no_live_socket' }) }));
  });

  it('Resume audits `resume` and answers paused: false', async () => {
    vi.mocked(resolveEnvInDrive).mockResolvedValue(localRow as never);
    vi.mocked(setEnvPaused).mockResolvedValue({ ok: true, paused: false } as never);
    const response = await patchEnv(jsonReq({ paused: false }), envParams);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ paused: false });
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.write', details: expect.objectContaining({ operation: 'resume' }) }));
  });

  it('given a drive ADMIN who did not enrol the machine, should refuse 403 naming the owner, audit it, and pause nothing', async () => {
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(true);
    vi.mocked(resolveEnvInDrive).mockResolvedValue(localRow as never);
    vi.mocked(setEnvPaused).mockResolvedValue({ ok: false, reason: 'not_owner', ownerId: 'user-owner' } as never);
    const response = await patchEnv(jsonReq({ paused: true }), envParams);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; reason: string; ownerId: string };
    expect(body).toMatchObject({ reason: 'not_owner', ownerId: 'user-owner' });
    expect(body.error).toMatch(/owner/i);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', details: expect.objectContaining({ operation: 'pause', ownerId: 'user-owner' }) }));
  });

  it('given a revoked env, should answer 409; given a SPRITE env, 409 not_local without calling the service', async () => {
    vi.mocked(resolveEnvInDrive).mockResolvedValue(localRow as never);
    vi.mocked(setEnvPaused).mockResolvedValue({ ok: false, reason: 'revoked' } as never);
    expect((await patchEnv(jsonReq({ paused: true }), envParams)).status).toBe(409);
    vi.mocked(setEnvPaused).mockClear();
    vi.mocked(resolveEnvInDrive).mockResolvedValue(envRow as never);
    const response = await patchEnv(jsonReq({ paused: true }), envParams);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'not_local' });
    expect(setEnvPaused).not.toHaveBeenCalled();
  });

  it('given paused alongside another field, or a non-boolean, should answer 400 and call nothing', async () => {
    vi.mocked(resolveEnvInDrive).mockResolvedValue(localRow as never);
    for (const body of [{ paused: true, name: 'x' }, { paused: true, serverPolicy: { ops: [], checkpoint: false } }, { paused: 'yes' }]) {
      expect((await patchEnv(jsonReq(body), envParams)).status).toBe(400);
    }
    expect(setEnvPaused).not.toHaveBeenCalled();
    expect(setEnvServerPolicy).not.toHaveBeenCalled();
    expect(renameEnv).not.toHaveBeenCalled();
  });
});

describe('PATCH /envs/[envId] — rename keeps its owner-OR-admin rule (two fields, two rules)', () => {
  it('given a rename by an admin, should never touch the server policy', async () => {
    vi.mocked(renameEnv).mockResolvedValue({ ok: true, env: { ...envRow, name: 'prod' } } as never);
    const response = await patchEnv(jsonReq({ name: 'prod' }), envParams);
    expect(response.status).toBe(200);
    expect(setEnvServerPolicy).not.toHaveBeenCalled();
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

  it('given a LOCAL env, should answer 409 substrate_unsupported — the user\'s own machine has no Sprite to replace (C1)', async () => {
    vi.mocked(rebuildEnv).mockResolvedValue({ ok: false, reason: 'substrate_unsupported' } as never);
    const response = await rebuildEnvRoute(rebuildReq(), envParams);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'substrate_unsupported' });
  });

  it('given the teardown failed, should answer 503 and say so', async () => {
    vi.mocked(rebuildEnv).mockResolvedValue({ ok: false, reason: 'teardown_failed', detail: 'boom' } as never);
    const response = await rebuildEnvRoute(rebuildReq(), envParams);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: 'teardown_failed' });
  });
});

describe('DELETE /envs/[envId] on a LOCAL env — revoke first (Codex C4), then delete', () => {
  const localRow = { id: ENV_ID, driveId: DRIVE_ID, name: 'mac', substrate: 'local' };
  const del = () => deleteEnvRoute(req(`http://localhost/api/drives/${DRIVE_ID}/envs/${ENV_ID}`, { method: 'DELETE' }), envParams);

  beforeEach(() => {
    vi.mocked(resolveEnvInDrive).mockResolvedValue(localRow as never);
    vi.mocked(deleteEnv).mockResolvedValue({ ok: true, spriteTornDown: false });
    vi.mocked(revokeEnv).mockResolvedValue({ ok: true, alreadyRevoked: false, revokedAt: new Date(), sessionsRevoked: 2, machine: 'sent_and_closed' });
  });

  it('given a drive owner/admin, should revoke the machine BEFORE deleting the row, audit the revoke, and report it', async () => {
    const order: string[] = [];
    vi.mocked(revokeEnv).mockImplementation(async () => {
      order.push('revoke');
      return { ok: true, alreadyRevoked: false, revokedAt: new Date(), sessionsRevoked: 2, machine: 'sent_and_closed' };
    });
    vi.mocked(deleteEnv).mockImplementation(async () => {
      order.push('delete');
      return { ok: true, spriteTornDown: false };
    });
    const response = await del();
    expect(response.status).toBe(200);
    expect(order).toEqual(['revoke', 'delete']);
    expect(revokeEnv).toHaveBeenCalledWith({ envId: ENV_ID, reason: 'owner_revoked' });
    expect(await response.json()).toEqual({ deleted: true, spriteTornDown: false, revoked: { sessionsRevoked: 2, machine: 'sent_and_closed', alreadyRevoked: false } });
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'auth.token.revoked', resourceType: 'drive_env', resourceId: ENV_ID, details: expect.objectContaining({ operation: 'revoke', sessionsRevoked: 2 }) }));
  });

  it('given a plain member, should refuse 403 through the centralized owner/admin check and revoke NOTHING', async () => {
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(false);
    const response = await del();
    expect(response.status).toBe(403);
    expect(revokeEnv).not.toHaveBeenCalled();
    expect(deleteEnv).not.toHaveBeenCalled();
  });

  it('given an env in another drive, should answer 404 and revoke NOTHING', async () => {
    vi.mocked(resolveEnvInDrive).mockResolvedValue(null);
    const response = await del();
    expect(response.status).toBe(404);
    expect(revokeEnv).not.toHaveBeenCalled();
  });

  it('given a Sprite env, should NOT call revoke — behaviour unchanged', async () => {
    vi.mocked(resolveEnvInDrive).mockResolvedValue({ ...localRow, substrate: 'sprite' } as never);
    const response = await del();
    expect(response.status).toBe(200);
    expect(revokeEnv).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ deleted: true, spriteTornDown: false });
  });

  it('given live sessions in the env, should still have revoked the machine (revocation is not a deletion) and answer 409', async () => {
    vi.mocked(deleteEnv).mockResolvedValue({ ok: false, reason: 'live_sessions', liveSessionCount: 1 });
    const response = await del();
    expect(response.status).toBe(409);
    expect(revokeEnv).toHaveBeenCalledTimes(1);
  });
});

describe('POST /envs/[envId]/enrollment-code — a fresh one-time code for a machine that has not enrolled (M3)', () => {
  const localRow = { ...envRow, name: 'mac', substrate: 'local' };
  const codeReq = () => req(`http://localhost/api/drives/${DRIVE_ID}/envs/${ENV_ID}/enrollment-code`, { method: 'POST' });
  const expiresAt = new Date('2026-09-07T10:10:00.000Z');

  beforeEach(() => {
    vi.mocked(isLocalEnvsEnabled).mockReturnValue(true);
    vi.mocked(resolveEnvInDrive).mockResolvedValue(localRow as never);
  });

  it('given a plain member, should refuse — the same bar as every other env write', async () => {
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(false);
    const response = await reissueCodeRoute(codeReq(), envParams);
    expect(response.status).toBe(403);
    expect(reissueEnvEnrollmentCode).not.toHaveBeenCalled();
  });

  it('given LOCAL_ENVS_ENABLED is off, should answer 501 and mint nothing', async () => {
    vi.mocked(isLocalEnvsEnabled).mockReturnValue(false);
    const response = await reissueCodeRoute(codeReq(), envParams);
    expect(response.status).toBe(501);
    expect(reissueEnvEnrollmentCode).not.toHaveBeenCalled();
  });

  it('given an env that is not in this drive, should answer 404 without minting', async () => {
    vi.mocked(resolveEnvInDrive).mockResolvedValue(null);
    const response = await reissueCodeRoute(codeReq(), envParams);
    expect(response.status).toBe(404);
    expect(reissueEnvEnrollmentCode).not.toHaveBeenCalled();
  });

  it('given a Sprite env, should answer 409 not_local — there is no code to re-issue', async () => {
    vi.mocked(resolveEnvInDrive).mockResolvedValue({ ...envRow, substrate: 'sprite' } as never);
    const response = await reissueCodeRoute(codeReq(), envParams);
    expect(response.status).toBe(409);
    expect((await response.json()).reason).toBe('not_local');
    expect(reissueEnvEnrollmentCode).not.toHaveBeenCalled();
  });

  it('given an admin and a pending local env, should answer 201 with the new code ONCE (expiry as ISO) and audit the write', async () => {
    vi.mocked(reissueEnvEnrollmentCode).mockResolvedValue({ ok: true, enrollment: { enrollmentId: 'enr_1', code: 'ABCDEFGHJKMNPQRSTVWX', expiresAt } });
    const response = await reissueCodeRoute(codeReq(), envParams);
    expect(response.status).toBe(201);
    expect(reissueEnvEnrollmentCode).toHaveBeenCalledWith({ envId: ENV_ID });
    expect(await response.json()).toEqual({ enrollment: { enrollmentId: 'enr_1', code: 'ABCDEFGHJKMNPQRSTVWX', expiresAt: expiresAt.toISOString() } });
    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write', details: expect.objectContaining({ operation: 'reissue-enrollment-code', envId: ENV_ID }) }),
    );
  });

  it('given a machine ALREADY enrolled, should answer 409 already_enrolled — final, never a new code', async () => {
    vi.mocked(reissueEnvEnrollmentCode).mockResolvedValue({ ok: false, reason: 'already_enrolled' });
    const response = await reissueCodeRoute(codeReq(), envParams);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { reason: string; enrollment?: unknown };
    expect(body.reason).toBe('already_enrolled');
    expect(body.enrollment).toBeUndefined();
  });

  it('given a revoked enrollment, should answer 410 revoked', async () => {
    vi.mocked(reissueEnvEnrollmentCode).mockResolvedValue({ ok: false, reason: 'revoked' });
    const response = await reissueCodeRoute(codeReq(), envParams);
    expect(response.status).toBe(410);
    expect((await response.json()).reason).toBe('revoked');
  });

  it('given the sibling row is gone (owner erased), should answer 404', async () => {
    vi.mocked(reissueEnvEnrollmentCode).mockResolvedValue({ ok: false, reason: 'not_found' });
    const response = await reissueCodeRoute(codeReq(), envParams);
    expect(response.status).toBe(404);
  });
});
