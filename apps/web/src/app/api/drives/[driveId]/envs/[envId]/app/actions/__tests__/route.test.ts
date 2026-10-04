/**
 * Contract test for `POST /api/drives/[driveId]/envs/[envId]/app/actions`, the manual way back out
 * of `parked` (review 5407898542 P1): resuming a PARKED app un-parks it through the lib service —
 * whose authority (creator, lead, org Owner/Admin) and cap re-check are tested against Postgres in
 * packages/lib/src/services/app-hosting/__tests__/app-unpark.integration.test.ts — and only then
 * wakes it. Mocked at the service seam.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
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
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({ resolveEnvInDrive: vi.fn() }));
vi.mock('@pagespace/lib/services/app-hosting/app-lifecycle-metering', () => ({
  stopPublishedApp: vi.fn(),
  wakePublishedApp: vi.fn(),
}));
vi.mock('@pagespace/lib/services/app-hosting/app-unpark', () => ({ unparkPublishedApp: vi.fn() }));
vi.mock('@/lib/app-hosting/published-app-dto', () => ({
  findPublishedAppByEnvId: vi.fn(),
  findPublishedAppById: vi.fn(),
  toPublishedAppDTO: vi.fn((app: { id: string; status: string }) => ({ id: app.id, status: app.status })),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions, isPrincipalDriveMember, isPrincipalDriveOwnerOrAdmin } from '@/lib/auth';
import { resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';
import { stopPublishedApp, wakePublishedApp } from '@pagespace/lib/services/app-hosting/app-lifecycle-metering';
import { unparkPublishedApp } from '@pagespace/lib/services/app-hosting/app-unpark';
import { findPublishedAppByEnvId, findPublishedAppById } from '@/lib/app-hosting/published-app-dto';

const DRIVE_ID = 'drive-1';
const ENV_ID = 'env-1';
const USER_ID = 'marcus';
const APP_ID = 'app-1';
const params = { params: Promise.resolve({ driveId: DRIVE_ID, envId: ENV_ID }) };
const post = (action: string) =>
  new Request(`http://localhost/api/drives/${DRIVE_ID}/envs/${ENV_ID}/app/actions`, { method: 'POST', body: JSON.stringify({ action }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: USER_ID } as never);
  vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(false);
  vi.mocked(isPrincipalDriveMember).mockResolvedValue(true);
  vi.mocked(resolveEnvInDrive).mockResolvedValue({ id: ENV_ID } as never);
  vi.mocked(findPublishedAppByEnvId).mockResolvedValue({ id: APP_ID, status: 'parked' } as never);
  vi.mocked(findPublishedAppById).mockResolvedValue({ id: APP_ID, status: 'running' } as never);
  vi.mocked(unparkPublishedApp).mockResolvedValue({ outcome: 'unparked', via: 'creator' });
  vi.mocked(wakePublishedApp).mockResolvedValue({ outcome: 'woken' } as never);
});

describe('POST /app/actions — resuming a parked app un-parks it', () => {
  it('WAL-2 (partial) a drive member who may un-park (the creator) gets it un-parked as THEMSELVES and then woken through the gate', async () => {
    const response = await POST(post('resume'), params);
    expect(response.status).toBe(200);
    expect(unparkPublishedApp).toHaveBeenCalledWith({ publishedAppId: APP_ID, actorId: USER_ID });
    expect(vi.mocked(wakePublishedApp).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(unparkPublishedApp).mock.invocationCallOrder[0]);
  });

  it('WAL-2 (partial) a member the un-park authority refuses gets 403 and nothing is woken', async () => {
    vi.mocked(unparkPublishedApp).mockResolvedValue({ outcome: 'refused', reason: 'forbidden' });
    const response = await POST(post('resume'), params);
    expect(response.status).toBe(403);
    expect(wakePublishedApp).not.toHaveBeenCalled();
  });

  it('WAL-2 (partial) a still-capped creator holds the app parked: 409 with the reason, nothing woken', async () => {
    vi.mocked(unparkPublishedApp).mockResolvedValue({ outcome: 'held', held: 'still_capped', gateReason: 'org_member_cap_reached' });
    const response = await POST(post('resume'), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'still_capped', gateReason: 'org_member_cap_reached' });
    expect(wakePublishedApp).not.toHaveBeenCalled();
  });

  it('a non-member is refused before the app is even looked up', async () => {
    vi.mocked(isPrincipalDriveMember).mockResolvedValue(false);
    const response = await POST(post('resume'), params);
    expect(response.status).toBe(403);
    expect(findPublishedAppByEnvId).not.toHaveBeenCalled();
    expect(unparkPublishedApp).not.toHaveBeenCalled();
  });

  it('a plain member still may not stop an app, or resume one that is not parked', async () => {
    expect((await POST(post('stop'), params)).status).toBe(403);
    vi.mocked(findPublishedAppByEnvId).mockResolvedValue({ id: APP_ID, status: 'stopped' } as never);
    expect((await POST(post('resume'), params)).status).toBe(403);
    expect(stopPublishedApp).not.toHaveBeenCalled();
    expect(unparkPublishedApp).not.toHaveBeenCalled();
    expect(wakePublishedApp).not.toHaveBeenCalled();
  });

  it('a drive owner or admin resuming a stopped (not parked) app wakes it without an un-park', async () => {
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(true);
    vi.mocked(findPublishedAppByEnvId).mockResolvedValue({ id: APP_ID, status: 'stopped' } as never);
    expect((await POST(post('resume'), params)).status).toBe(200);
    expect(unparkPublishedApp).not.toHaveBeenCalled();
    expect(wakePublishedApp).toHaveBeenCalledWith(APP_ID);
  });
});
