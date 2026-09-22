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
vi.mock('@/lib/drive-envs/env-oauth-client-runtime', () => ({
  syncEnvOAuthClientBestEffort: vi.fn(async () => undefined),
  syncEnvOAuthClientForRemoval: vi.fn(async () => ({ ok: true })),
  retireEnvOAuthClientBestEffort: vi.fn(async () => ({ clientId: 'env_x', disabled: true, familiesRevoked: 0 })),
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
  toPublishedAppDTO: vi.fn((app: { id: string }) => ({ id: app.id })),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions, isPrincipalDriveOwnerOrAdmin } from '@/lib/auth';
import { resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';
import { createPublishedApp } from '@pagespace/lib/services/app-hosting/provisioner';
import { findPublishedAppByEnvId } from '@/lib/app-hosting/published-app-dto';
import { ensureBuildableSource } from '@/lib/app-hosting/publish-source-check';
import { snapshotEnvFilesystem } from '@/lib/app-hosting/env-snapshot';
import { enqueuePublishBuild } from '@/lib/app-hosting/publish-build-enqueue';
import { destroyPublishedApp } from '@pagespace/lib/services/app-hosting/provisioner';
import { syncEnvOAuthClientBestEffort, syncEnvOAuthClientForRemoval } from '@/lib/drive-envs/env-oauth-client-runtime';
import { DELETE } from '../route';

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
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: USER_ID } as never);
  vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(true);
  vi.mocked(resolveEnvInDrive).mockResolvedValue(envRow as never);
  vi.mocked(findPublishedAppByEnvId).mockResolvedValue(null);
  vi.mocked(createPublishedApp).mockResolvedValue({ ok: true, app: appRow } as never);
  updateReturning.mockReset().mockResolvedValue([{ id: PUBLISHED_APP_ID, status: 'building' }]);
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
    // Sign in with PageSpace (US6): a publish re-syncs the env's OAuth client so
    // the published origin becomes a redirect URI, AFTER the hosting row is claimed.
    expect(syncEnvOAuthClientBestEffort).toHaveBeenCalledWith({ envId: ENV_ID }, expect.objectContaining({ operation: 'publish', publishedAppId: PUBLISHED_APP_ID }));
  });

  it('given a refused publish (unbuildable source), never touches the env OAuth client', async () => {
    vi.mocked(ensureBuildableSource).mockResolvedValue({ ok: false, reason: 'no_recognizable_source' });
    await POST(postReq(), envParams);
    expect(syncEnvOAuthClientBestEffort).not.toHaveBeenCalled();
  });

  it('given an unpublish, removes the published redirect from the env OAuth client BEFORE the hosting row is destroyed', async () => {
    const order: string[] = [];
    vi.mocked(findPublishedAppByEnvId).mockResolvedValue({ ...appRow, status: 'running' } as never);
    vi.mocked(syncEnvOAuthClientForRemoval).mockImplementationOnce(async () => { order.push('remove'); return { ok: true } as never; });
    vi.mocked(destroyPublishedApp).mockImplementationOnce(async () => { order.push('destroy'); return { ok: true } as never; });
    const response = await DELETE(new Request(`http://localhost/api/drives/${DRIVE_ID}/envs/${ENV_ID}/app`, { method: 'DELETE' }), envParams);
    expect(response.status).toBe(200);
    expect(syncEnvOAuthClientForRemoval).toHaveBeenCalledWith({ envId: ENV_ID }, { unpublish: true });
    expect(order).toEqual(['remove', 'destroy']);
  });

  it('given the removal write fails, the unpublish FAILS and nothing is destroyed — a removal is never best-effort', async () => {
    vi.mocked(findPublishedAppByEnvId).mockResolvedValue({ ...appRow, status: 'running' } as never);
    vi.mocked(syncEnvOAuthClientForRemoval).mockRejectedValueOnce(new Error('db down'));
    const response = await DELETE(new Request(`http://localhost/api/drives/${DRIVE_ID}/envs/${ENV_ID}/app`, { method: 'DELETE' }), envParams);
    expect(response.status).toBe(500);
    expect(destroyPublishedApp).not.toHaveBeenCalled();
  });

  it('given an env that is not published, touches no client', async () => {
    const response = await DELETE(new Request(`http://localhost/api/drives/${DRIVE_ID}/envs/${ENV_ID}/app`, { method: 'DELETE' }), envParams);
    expect(response.status).toBe(404);
    expect(syncEnvOAuthClientForRemoval).not.toHaveBeenCalled();
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
