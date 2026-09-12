/**
 * `GET /api/env-bridge/machines` (GA wave 3, leaf 5) — every machine the
 * caller OWNS across drives, selected by owner in the store; audited.
 */
import { it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pagespace/lib/services/drive-envs/local-envs-enabled', () => ({ isLocalEnvsEnabled: vi.fn(() => true) }));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn(() => false) }));
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({ listOwnerMachines: vi.fn() }));

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import { listOwnerMachines } from '@/lib/drive-envs/drive-envs-runtime';

const OWNER = 'user-owner';
const get = () => GET(new Request('http://localhost/api/env-bridge/machines'));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isLocalEnvsEnabled).mockReturnValue(true);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: OWNER } as never);
  vi.mocked(listOwnerMachines).mockResolvedValue([{ env: { id: 'env-1', substrate: 'local', label: 'mac' }, driveId: 'drive-1' }] as never);
});

it('given the flag off, should answer 404 and read nothing', async () => {
  vi.mocked(isLocalEnvsEnabled).mockReturnValue(false);
  expect((await get()).status).toBe(404);
  expect(listOwnerMachines).not.toHaveBeenCalled();
});

it('given a signed-in user, should list machines by OWNER = the caller, each with its drive, and audit the read', async () => {
  const r = await get();
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ machines: [{ env: { id: 'env-1', substrate: 'local', label: 'mac' }, driveId: 'drive-1' }] });
  expect(listOwnerMachines).toHaveBeenCalledWith(OWNER);
  expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.read', userId: OWNER, details: expect.objectContaining({ route: 'env-bridge/machines', rows: 1 }) }));
});

it('given the store throws, should answer 500 without leaking the error', async () => {
  vi.mocked(listOwnerMachines).mockRejectedValue(new Error('db down'));
  const r = await get();
  expect(r.status).toBe(500);
  expect(JSON.stringify(await r.json())).not.toContain('db down');
});
