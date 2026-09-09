/**
 * `GET /api/env-bridge/activity` (GA wave 3, leaf 2) — the account page's
 * read: activity across every machine the caller OWNS, selected by owner in
 * the store so it can never contain anyone else's machine.
 */
import { it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pagespace/lib/services/drive-envs/local-envs-enabled', () => ({ isLocalEnvsEnabled: vi.fn(() => true) }));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn(() => false) }));
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({ listOwnerActivity: vi.fn() }));

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import { listOwnerActivity } from '@/lib/drive-envs/drive-envs-runtime';

const OWNER = 'user-owner';
const get = () => GET(new Request('http://localhost/api/env-bridge/activity'));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isLocalEnvsEnabled).mockReturnValue(true);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: OWNER } as never);
  vi.mocked(listOwnerActivity).mockResolvedValue([{ id: 'row-1', envId: 'env-1', verdict: 'signed' }] as never);
});

it('given the flag off, should answer 404 and read nothing (invariant 11)', async () => {
  vi.mocked(isLocalEnvsEnabled).mockReturnValue(false);
  expect((await get()).status).toBe(404);
  expect(listOwnerActivity).not.toHaveBeenCalled();
});

it('given a signed-in user, should list by OWNER = the caller (never a requested id) and audit the read', async () => {
  const r = await get();
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ activity: [{ id: 'row-1', envId: 'env-1', verdict: 'signed' }] });
  expect(listOwnerActivity).toHaveBeenCalledWith({ ownerId: OWNER, limit: 50 });
  expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.read', userId: OWNER, resourceType: 'drive_env_activity', details: expect.objectContaining({ route: 'env-bridge/activity', rows: 1 }) }));
});

it('given the store throws, should answer 500 without leaking the error', async () => {
  vi.mocked(listOwnerActivity).mockRejectedValue(new Error('db down'));
  const r = await get();
  expect(r.status).toBe(500);
  expect(JSON.stringify(await r.json())).not.toContain('db down');
});
