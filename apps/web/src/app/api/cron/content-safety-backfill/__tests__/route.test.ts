/**
 * Contract tests for /api/cron/content-safety-backfill: HMAC gating, the on-prem / off / no-key no-ops, the dry
 * run (no tick, no scanner), and a failed object turning the run into a 500. The walk itself is proven in
 * packages/lib/src/content-safety/__tests__/backfill.test.ts, the actions in backfill-service.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockTick, mockDryRun, mockAudit, mockIsOnPrem, mockCreateDeps, mockCreateDryRunDeps } = vi.hoisted(() => ({
  mockTick: vi.fn(),
  mockDryRun: vi.fn(),
  mockAudit: vi.fn(),
  mockIsOnPrem: vi.fn(),
  mockCreateDeps: vi.fn(() => ({ tag: 'deps' })),
  mockCreateDryRunDeps: vi.fn(() => ({ tag: 'dry' })),
}));

vi.mock('@/lib/auth/cron-auth', () => ({ validateSignedCronRequest: vi.fn() }));
vi.mock('@pagespace/lib/deployment-mode', () => ({ isOnPrem: mockIsOnPrem }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: mockAudit }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { system: { error: vi.fn(), warn: vi.fn() } } }));
vi.mock('@/lib/content-safety/backfill-service', () => ({ createBackfillDeps: mockCreateDeps, createDryRunDeps: mockCreateDryRunDeps }));
vi.mock('@pagespace/lib/content-safety/backfill', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/content-safety/backfill')>();
  return { ...actual, runBackfillTick: mockTick, runBackfillDryRun: mockDryRun };
});

import { GET } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

const request = (query = '') => new Request(`http://localhost:3000/api/cron/content-safety-backfill${query}`);

describe('/api/cron/content-safety-backfill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockIsOnPrem.mockReturnValue(false);
    vi.stubEnv('CONTENT_SCAN_MODE', 'shadow');
    vi.stubEnv('HIVE_API_KEY', 'k');
    mockTick.mockResolvedValue({ state: 'walked', pass: 1, phase: 'assets', processed: 25, scanned: 10, completed: false });
    mockDryRun.mockResolvedValue({ counts: {}, estimatedVendorCalls: 7, next: null });
  });

  it('refuses an unsigned request and walks nothing', async () => {
    vi.mocked(validateSignedCronRequest).mockReturnValue(new Response('no', { status: 401 }) as never);
    expect((await GET(request())).status).toBe(401);
    expect(mockTick).not.toHaveBeenCalled();
  });

  it('is a no-op on-prem, for the real run and the dry run', async () => {
    mockIsOnPrem.mockReturnValue(true);
    for (const query of ['', '?dryRun=1']) {
      const response = await GET(request(query));
      expect(await response.json()).toEqual({ success: true, skipped: 'onprem' });
    }
    expect(mockTick).not.toHaveBeenCalled();
    expect(mockDryRun).not.toHaveBeenCalled();
  });

  it('is a no-op with scanning off, and without a vendor key (nothing would be recorded)', async () => {
    vi.stubEnv('CONTENT_SCAN_MODE', 'off');
    expect(await (await GET(request())).json()).toEqual({ success: true, skipped: 'scan_off' });
    vi.stubEnv('CONTENT_SCAN_MODE', 'enforce');
    vi.stubEnv('HIVE_API_KEY', '');
    expect(await (await GET(request())).json()).toEqual({ success: true, skipped: 'scanner_not_configured' });
    expect(mockTick).not.toHaveBeenCalled();
  });

  it('a dry run counts only: no tick, no gate deps, works with scanning off, and passes the continuation', async () => {
    vi.stubEnv('CONTENT_SCAN_MODE', 'off');
    const response = await GET(request('?dryRun=1&phase=avatars&startAfter=avatars/u1/avatar.png&maxPages=3'));
    expect(await response.json()).toEqual({ success: true, dryRun: true, mode: 'off', counts: {}, estimatedVendorCalls: 7, next: null });
    expect(mockTick).not.toHaveBeenCalled();
    expect(mockCreateDeps).not.toHaveBeenCalled();
    expect(mockDryRun).toHaveBeenCalledWith({ tag: 'dry' }, expect.objectContaining({ maxPages: 3, from: { phase: 'avatars', startAfter: 'avatars/u1/avatar.png' } }));
  });

  it('runs one tick with the configured per-tick limit and audits it', async () => {
    vi.stubEnv('CONTENT_SCAN_BACKFILL_ITEMS_PER_TICK', '7');
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, state: 'walked', pass: 1, phase: 'assets', processed: 25, scanned: 10, completed: false });
    expect(mockTick).toHaveBeenCalledWith({ tag: 'deps' }, expect.objectContaining({ itemsPerTick: 7 }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'content_safety_backfill' }));
  });

  it('an object that could not be checked is a 500, without naming the key', async () => {
    mockTick.mockResolvedValue({ state: 'walked', pass: 1, phase: 'avatars', processed: 2, scanned: 1, completed: false, failedKey: 'avatars/user-9/avatar.png' });
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('user-9');
  });

  it('reports a busy or idle walker', async () => {
    mockTick.mockResolvedValueOnce({ state: 'busy' });
    expect(await (await GET(request())).json()).toEqual({ success: true, state: 'busy' });
    mockTick.mockResolvedValueOnce({ state: 'idle', pass: 2, nextPassAt: new Date('2026-11-14T00:00:00Z') });
    expect(await (await GET(request())).json()).toEqual({ success: true, state: 'idle', pass: 2, nextPassAt: '2026-11-14T00:00:00.000Z' });
  });
});
