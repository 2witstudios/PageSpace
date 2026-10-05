/**
 * Contract test for the up-front buildability refusal on
 * `POST /api/drives/[driveId]/envs/[envId]/app`.
 *
 * Mocked at the SERVICE SEAM, matching `envs/__tests__/routes.test.ts`. The
 * one thing this asserts: when `ensureBuildableSource` refuses, the route
 * answers a 4xx WITHOUT ever calling `snapshotEnvFilesystem` or
 * `enqueuePublishBuild` — the whole point of checking up front (D1) is that a
 * source PageSpace cannot build never pays for a snapshot/tar/upload round
 * trip.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/organizations/policy-reader', () => ({ getDrivePolicies: vi.fn() }));
vi.mock('@pagespace/lib/billing/compute-gate', () => ({ admitDriveComputeCreator: vi.fn(), admitDriveOrgActive: vi.fn() }));
vi.mock('@pagespace/lib/permissions/app-unpark-authority', () => ({ canUnparkPublishedApp: vi.fn() }));
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
  resolveEnvInDrive: vi.fn(),
}));
vi.mock('@pagespace/lib/services/app-hosting/provisioner', () => ({
  createPublishedApp: vi.fn(),
  destroyPublishedApp: vi.fn(),
}));
vi.mock('@pagespace/lib/services/app-hosting/app-hosting-env', () => ({
  resolvePublishedAppsOrgSlug: vi.fn(() => 'acme'),
}));
vi.mock('@pagespace/lib/services/subdomain-allocation', () => ({
  allocateUniqueSubdomainWithRetry: vi.fn(),
}));
vi.mock('@/lib/app-hosting/env-snapshot', () => ({
  snapshotEnvFilesystem: vi.fn(),
}));
vi.mock('@/lib/app-hosting/publish-source-check', () => ({
  ensureBuildableSource: vi.fn(),
  describeUnbuildableSourceReason: vi.fn(() => 'This environment has no Dockerfile, package.json, or index.html.'),
}));
vi.mock('@/lib/app-hosting/publish-build-enqueue', () => ({
  enqueuePublishBuild: vi.fn(),
}));
// `update` defaults to "claim succeeds" (returns the row) so every existing
// happy-path test keeps working without knowing about the CAS guard; a test
// that needs to simulate a lost race overrides this per-test.
const updateReturning = vi.fn(() => Promise.resolve([{ id: PUBLISHED_APP_ID, status: 'building' }]));
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => Promise.resolve([])) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: () => updateReturning(),
        })),
      })),
    })),
  },
}));
vi.mock('@/lib/app-hosting/published-app-dto', () => ({
  findPublishedAppByEnvId: vi.fn(),
  toPublishedAppDTO: vi.fn((app: { id: string }, viewerCanUnpark = false) => ({ id: app.id, viewerCanUnpark })),
}));

import { GET, POST } from '../route';
import { canUnparkPublishedApp } from '@pagespace/lib/permissions/app-unpark-authority';
import { admitDriveComputeCreator, admitDriveOrgActive } from '@pagespace/lib/billing/compute-gate';
import { getDrivePolicies } from '@pagespace/lib/organizations/policy-reader';
import { DEFAULT_ORG_POLICIES } from '@pagespace/lib/organizations/policies-core';
import { authenticateRequestWithOptions, isPrincipalDriveMember, isPrincipalDriveOwnerOrAdmin } from '@/lib/auth';
import { resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';
import { createPublishedApp } from '@pagespace/lib/services/app-hosting/provisioner';
import { findPublishedAppByEnvId } from '@/lib/app-hosting/published-app-dto';
import { ensureBuildableSource } from '@/lib/app-hosting/publish-source-check';
import { snapshotEnvFilesystem } from '@/lib/app-hosting/env-snapshot';
import { enqueuePublishBuild } from '@/lib/app-hosting/publish-build-enqueue';

const DRIVE_ID = 'drive-1';
const ENV_ID = 'env-1';
const USER_ID = 'user-1';
const PUBLISHED_APP_ID = 'app-1';

const envParams = { params: Promise.resolve({ driveId: DRIVE_ID, envId: ENV_ID }) };

function postReq(): Request {
  return new Request(`http://localhost/api/drives/${DRIVE_ID}/envs/${ENV_ID}/app`, { method: 'POST' });
}

const envRow = { id: ENV_ID, driveId: DRIVE_ID, name: 'staging', sandboxId: 'sandbox-1' };
const appRow = { id: PUBLISHED_APP_ID, envId: ENV_ID, subdomain: 'staging-abc' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDrivePolicies).mockResolvedValue({ policies: DEFAULT_ORG_POLICIES } as never);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: USER_ID } as never);
  vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(true);
  vi.mocked(resolveEnvInDrive).mockResolvedValue(envRow as never);
  vi.mocked(findPublishedAppByEnvId).mockResolvedValue(null);
  vi.mocked(admitDriveComputeCreator).mockResolvedValue({ allowed: true });
  vi.mocked(admitDriveOrgActive).mockResolvedValue({ allowed: true });
  vi.mocked(createPublishedApp).mockResolvedValue({ ok: true, app: appRow } as never);
  updateReturning.mockReset().mockResolvedValue([{ id: PUBLISHED_APP_ID, status: 'building' }]);
});

describe('POST /app — an org that turned published apps off', () => {
  it('POL-10 refuses 403 org_policy before the buildability check, the snapshot or the provisioner', async () => {
    vi.mocked(getDrivePolicies).mockResolvedValue({ policies: { ...DEFAULT_ORG_POLICIES, publishedApps: false } } as never);
    const response = await POST(postReq(), envParams);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'org_policy', policy: 'publishedApps' });
    expect(ensureBuildableSource).not.toHaveBeenCalled();
    expect(snapshotEnvFilesystem).not.toHaveBeenCalled();
    expect(createPublishedApp).not.toHaveBeenCalled();
  });

  it('POL-10 maps the provisioner\'s own org_policy refusal the same way', async () => {
    vi.mocked(ensureBuildableSource).mockResolvedValue({ ok: true });
    vi.mocked(snapshotEnvFilesystem).mockResolvedValue({ ok: true, tarPath: '/t.tar.gz', cleanup: vi.fn() } as never);
    vi.mocked(createPublishedApp).mockResolvedValue({ ok: false, reason: 'org_policy' } as never);
    const response = await POST(postReq(), envParams);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'org_policy' });
  });
});

describe('POST /app — the up-front buildability refusal (D1)', () => {
  it('given an unrecognizable source, refuses before snapshotting or enqueueing', async () => {
    vi.mocked(ensureBuildableSource).mockResolvedValue({ ok: false, reason: 'no_recognizable_source' });

    const response = await POST(postReq(), envParams);

    expect(response.status).toBe(400);
    expect(snapshotEnvFilesystem).not.toHaveBeenCalled();
    expect(enqueuePublishBuild).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.reason).toBe('no_recognizable_source');
  });

  it('given a package.json with no start command, refuses before snapshotting or enqueueing', async () => {
    vi.mocked(ensureBuildableSource).mockResolvedValue({ ok: false, reason: 'node_missing_start_command' });

    const response = await POST(postReq(), envParams);

    expect(response.status).toBe(400);
    expect(snapshotEnvFilesystem).not.toHaveBeenCalled();
    expect(enqueuePublishBuild).not.toHaveBeenCalled();
  });

  it('given no live sandbox, answers 409 before snapshotting or enqueueing', async () => {
    vi.mocked(ensureBuildableSource).mockResolvedValue({ ok: false, reason: 'no_live_sandbox' });

    const response = await POST(postReq(), envParams);

    expect(response.status).toBe(409);
    expect(snapshotEnvFilesystem).not.toHaveBeenCalled();
    expect(enqueuePublishBuild).not.toHaveBeenCalled();
  });

  it('given a snapshot failure on a FIRST-TIME publish, never calls createPublishedApp — a first publish must not leave a Fly app + row behind a failed snapshot', async () => {
    vi.mocked(ensureBuildableSource).mockResolvedValue({ ok: true });
    vi.mocked(snapshotEnvFilesystem).mockResolvedValue({ ok: false, reason: 'too_large', detail: '600MB' } as never);

    const response = await POST(postReq(), envParams);

    expect(response.status).toBe(413);
    expect(createPublishedApp).not.toHaveBeenCalled();
    expect(enqueuePublishBuild).not.toHaveBeenCalled();
    // No `app` in the body either — nothing was created, so there is nothing
    // to report a DTO for (the response used to carry a stale `created.app`).
    const body = await response.json();
    expect(body.app).toBeUndefined();
  });

  it('a snapshot taken successfully is still cleaned up if createPublishedApp itself then fails', async () => {
    vi.mocked(ensureBuildableSource).mockResolvedValue({ ok: true });
    const cleanup = vi.fn();
    vi.mocked(snapshotEnvFilesystem).mockResolvedValue({ ok: true, tarPath: '/tmp/snapshot.tar.gz', cleanup } as never);
    vi.mocked(createPublishedApp).mockResolvedValue({ ok: false, reason: 'fly_error', error: 'fly down' } as never);

    const response = await POST(postReq(), envParams);

    expect(response.status).toBe(502);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(enqueuePublishBuild).not.toHaveBeenCalled();
  });

  it('given a build already in progress, refuses with 409 before any Dockerfile check, snapshot, or enqueue', async () => {
    vi.mocked(findPublishedAppByEnvId).mockResolvedValue({ ...appRow, status: 'building' } as never);

    const response = await POST(postReq(), envParams);

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.reason).toBe('build_in_progress');
    expect(createPublishedApp).not.toHaveBeenCalled();
    expect(ensureBuildableSource).not.toHaveBeenCalled();
    expect(snapshotEnvFilesystem).not.toHaveBeenCalled();
    expect(enqueuePublishBuild).not.toHaveBeenCalled();
  });

  it('given an app that is deploying (not just building), also refuses with 409', async () => {
    vi.mocked(findPublishedAppByEnvId).mockResolvedValue({ ...appRow, status: 'deploying' } as never);

    const response = await POST(postReq(), envParams);

    expect(response.status).toBe(409);
    expect(snapshotEnvFilesystem).not.toHaveBeenCalled();
  });

  it('given an app that is merely running (no build in flight), does not trip the concurrency guard', async () => {
    vi.mocked(findPublishedAppByEnvId).mockResolvedValue({ ...appRow, status: 'running' } as never);
    vi.mocked(ensureBuildableSource).mockResolvedValue({ ok: true });
    vi.mocked(snapshotEnvFilesystem).mockResolvedValue({
      ok: true,
      tarPath: '/tmp/snapshot.tar.gz',
      cleanup: vi.fn(),
    } as never);
    vi.mocked(enqueuePublishBuild).mockResolvedValue({ jobId: 'job-1', sourceRef: 'ref-1' });

    const response = await POST(postReq(), envParams);

    expect(response.status).toBe(200);
    expect(enqueuePublishBuild).toHaveBeenCalled();
  });

  it('given two publishes racing past the early status check, the CAS lets exactly one through and 409s the loser', async () => {
    // The early `findPublishedAppByEnvId` read sees a non-building status (the
    // race window this guard exists for), but by the time the CAS UPDATE runs
    // another request already flipped the row to `building` — simulated by
    // the update's WHERE clause matching zero rows.
    vi.mocked(ensureBuildableSource).mockResolvedValue({ ok: true });
    vi.mocked(snapshotEnvFilesystem).mockResolvedValue({
      ok: true,
      tarPath: '/tmp/snapshot.tar.gz',
      cleanup: vi.fn(),
    } as never);
    updateReturning.mockResolvedValue([]);

    const response = await POST(postReq(), envParams);

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.reason).toBe('build_in_progress');
    expect(enqueuePublishBuild).not.toHaveBeenCalled();
  });

  it('given a buildable source, proceeds to snapshot and enqueue', async () => {
    vi.mocked(ensureBuildableSource).mockResolvedValue({ ok: true });
    vi.mocked(snapshotEnvFilesystem).mockResolvedValue({
      ok: true,
      tarPath: '/tmp/snapshot.tar.gz',
      cleanup: vi.fn(),
    } as never);
    vi.mocked(enqueuePublishBuild).mockResolvedValue({ jobId: 'job-1', sourceRef: 'ref-1' });

    const response = await POST(postReq(), envParams);

    expect(response.status).toBe(200);
    expect(ensureBuildableSource).toHaveBeenCalledWith(envRow.sandboxId);
    expect(snapshotEnvFilesystem).toHaveBeenCalled();
    expect(enqueuePublishBuild).toHaveBeenCalled();
  });
});

describe('POST /app — the publisher\'s per-member cap ([D-OW-28])', () => {
  it('WAL-2 (partial) a FIRST publish by a member at their cap is refused 402 before any snapshot, and no app is created', async () => {
    vi.mocked(admitDriveComputeCreator).mockResolvedValue({ allowed: false, code: 'org_member_cap_reached', message: 'You have used your allowance' });

    const response = await POST(postReq(), envParams);

    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: 'You have used your allowance', code: 'org_member_cap_reached' });
    expect(admitDriveComputeCreator).toHaveBeenCalledWith({ driveId: expect.any(String), userId: USER_ID });
    expect(snapshotEnvFilesystem).not.toHaveBeenCalled();
    expect(createPublishedApp).not.toHaveBeenCalled();
  });

  it('a RE-publish creates nothing new, so it is not re-admitted', async () => {
    vi.mocked(findPublishedAppByEnvId).mockResolvedValue({ ...appRow, status: 'running' } as never);
    vi.mocked(admitDriveComputeCreator).mockResolvedValue({ allowed: false, code: 'org_member_cap_reached', message: 'cap' });

    await POST(postReq(), envParams);

    expect(admitDriveComputeCreator).not.toHaveBeenCalled();
  });
});

describe('POST /app — a lapsed org publishes nothing (review #2761 P2-1)', () => {
  const LAPSED = { allowed: false as const, code: 'org_lapsed' as const, message: 'This organization\'s subscription has lapsed.' };

  it('SEAT-9 (partial) a RE-publish of an existing app in a lapsed org is refused 402 org_lapsed before any snapshot, upload or build', async () => {
    vi.mocked(findPublishedAppByEnvId).mockResolvedValue({ ...appRow, status: 'running' } as never);
    vi.mocked(admitDriveOrgActive).mockResolvedValue(LAPSED);

    const response = await POST(postReq(), envParams);

    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: LAPSED.message, code: 'org_lapsed' });
    expect(admitDriveOrgActive).toHaveBeenCalledWith({ driveId: DRIVE_ID });
    expect(ensureBuildableSource).not.toHaveBeenCalled();
    expect(snapshotEnvFilesystem).not.toHaveBeenCalled();
    expect(enqueuePublishBuild).not.toHaveBeenCalled();
  });

  it('SEAT-9 (partial) a FIRST publish in a lapsed org is refused with code org_lapsed, not the member-cap code', async () => {
    vi.mocked(admitDriveOrgActive).mockResolvedValue(LAPSED);
    vi.mocked(admitDriveComputeCreator).mockResolvedValue(LAPSED);

    const response = await POST(postReq(), envParams);

    expect(response.status).toBe(402);
    expect((await response.json()).code).toBe('org_lapsed');
    expect(createPublishedApp).not.toHaveBeenCalled();
  });
});

describe('GET /app — whether this viewer may un-park a parked app', () => {
  const getReq = () => new Request(`http://localhost/api/drives/${DRIVE_ID}/envs/${ENV_ID}/app`);

  it('WAL-2 (partial) asks the permissions module for a PARKED app and says so on the row', async () => {
    vi.mocked(isPrincipalDriveMember).mockResolvedValue(true);
    vi.mocked(findPublishedAppByEnvId).mockResolvedValue({ ...appRow, status: 'parked', driveId: DRIVE_ID, costOwnerId: USER_ID } as never);
    vi.mocked(canUnparkPublishedApp).mockResolvedValue(true);

    const response = await GET(getReq(), envParams);

    expect(await response.json()).toEqual({ app: { id: PUBLISHED_APP_ID, viewerCanUnpark: true } });
    expect(canUnparkPublishedApp).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ driveId: DRIVE_ID, costOwnerId: USER_ID }));
  });

  it('does not ask for an app that is not parked', async () => {
    vi.mocked(isPrincipalDriveMember).mockResolvedValue(true);
    vi.mocked(findPublishedAppByEnvId).mockResolvedValue({ ...appRow, status: 'running' } as never);

    const response = await GET(getReq(), envParams);

    expect(await response.json()).toEqual({ app: { id: PUBLISHED_APP_ID, viewerCanUnpark: false } });
    expect(canUnparkPublishedApp).not.toHaveBeenCalled();
  });
});
