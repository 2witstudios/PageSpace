import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  withAdminAuth: (handler: (admin: { id: string }, req: Request) => Promise<Response>) =>
    (req: Request) => handler({ id: 'admin-1' }, req),
}));
const { env, cursor, shadow, open } = vi.hoisted(() => ({ env: vi.fn(), cursor: vi.fn(), shadow: vi.fn(), open: vi.fn() }));
vi.mock('@/lib/content/web-readiness', () => ({ fetchWebScanEnvironment: env }));
vi.mock('@pagespace/lib/content-safety/backfill-store', () => ({ readBackfillCursor: cursor }));
vi.mock('@pagespace/lib/content-safety/scan-store', () => ({ countShadowOutcomesSince: shadow, countOpenScanFlaggedCases: open }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: vi.fn() } } }));

import { GET } from '../route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const facts = { onPrem: false, mode: 'shadow', problems: [], hiveKeySet: true, evidenceBucketSet: false, abuseEmailSet: true, publishBucketSet: true, allowUnclassifiedVideo: false };

describe('GET /api/admin/content/readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.mockResolvedValue(facts);
    cursor.mockResolvedValue(null);
    shadow.mockResolvedValue([{ outcome: 'classifier_flag', count: 3 }]);
    open.mockResolvedValue(0);
  });

  it('combines the web environment, backfill, shadow counts and open flags, and audits the read', async () => {
    const res = await GET(new Request('http://admin/api/admin/content/readiness?days=7'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ready: false, mode: 'shadow', days: 7 });
    const blocking = body.items.filter((item: { status: string }) => item.status === 'blocking').map((item: { id: string }) => item.id);
    expect(blocking).toEqual(['evidence_bucket', 'backfill']);
    expect(env).toHaveBeenCalledWith('admin-1');
    const since = shadow.mock.calls[0][0] as Date;
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 50);
    expect(auditRequest).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ resourceId: 'readiness' }));
  });

  it('answers 500 when a count fails', async () => {
    open.mockRejectedValue(new Error('db'));
    expect((await GET(new Request('http://admin/api/admin/content/readiness'))).status).toBe(500);
  });
});
