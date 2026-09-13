/**
 * `GET /api/env-bridge/environments` (leaf B) — every environment the GLOBAL
 * ASSISTANT may reach for the caller. TWO conditions, applied in the store:
 * the caller owns the machine AND its owner made it visible.
 */
import { it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pagespace/lib/services/drive-envs/local-envs-enabled', () => ({ isLocalEnvsEnabled: vi.fn(() => true) }));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn(() => false) }));
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({ listGlobalAssistantEnvironments: vi.fn() }));

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import { listGlobalAssistantEnvironments } from '@/lib/drive-envs/drive-envs-runtime';

const OWNER = 'user-owner';
const ROW = { id: 'env_dw9jthqyaza6ga3b6m5n', label: 'jono-macstudio', substrate: 'local', driveId: 'drive-1' };
const get = () => GET(new Request('http://localhost/api/env-bridge/environments'));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isLocalEnvsEnabled).mockReturnValue(true);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: OWNER } as never);
  vi.mocked(listGlobalAssistantEnvironments).mockResolvedValue([ROW] as never);
});

it('given the feature flag is off, should answer 404 like every other route in the family, and read nothing', async () => {
  vi.mocked(isLocalEnvsEnabled).mockReturnValue(false);
  expect((await get()).status).toBe(404);
  expect(listGlobalAssistantEnvironments).not.toHaveBeenCalled();
});

it('given a signed-in user, should list by the CALLER — never a drive role — with an id, a label, the substrate and the owning drive, and audit the read', async () => {
  const r = await get();
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ environments: [ROW] });
  expect(listGlobalAssistantEnvironments).toHaveBeenCalledWith(OWNER);
  expect(auditRequest).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ eventType: 'data.read', userId: OWNER, details: expect.objectContaining({ route: 'env-bridge/environments', rows: 1 }) }),
  );
});

it('given nothing visible, should answer an empty list — the WORDS live in the tool, which is what a model reads', async () => {
  vi.mocked(listGlobalAssistantEnvironments).mockResolvedValue([] as never);
  const r = await get();
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ environments: [] });
});

it('given the store throws, should answer 500 without leaking the error', async () => {
  vi.mocked(listGlobalAssistantEnvironments).mockRejectedValue(new Error('db down'));
  const r = await get();
  expect(r.status).toBe(500);
  expect(JSON.stringify(await r.json())).not.toContain('db down');
});
