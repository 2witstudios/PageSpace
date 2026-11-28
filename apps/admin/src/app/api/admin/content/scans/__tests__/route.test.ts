import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  withAdminAuth: (handler: (admin: { id: string }, req: Request) => Promise<Response>) =>
    (req: Request) => handler({ id: 'admin-1' }, req),
}));
const { countMock } = vi.hoisted(() => ({ countMock: vi.fn() }));
vi.mock('@pagespace/lib/content-safety/scan-store', () => ({ countScanVerdicts: countMock }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: vi.fn() } } }));

import { GET } from '../route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

describe('GET /api/admin/content/scans', () => {
  it('returns counts only, and audits the read', async () => {
    countMock.mockResolvedValue([{ mode: 'shadow', outcome: 'clean', verdict: 'clean', count: 12 }]);
    const res = await GET(new Request('http://admin/api/admin/content/scans'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ counts: [{ mode: 'shadow', outcome: 'clean', verdict: 'clean', count: 12 }] });
    expect(auditRequest).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ eventType: 'content.case.read', resourceType: 'content_scans' }));
  });

  it('answers 500 when the count fails', async () => {
    countMock.mockRejectedValue(new Error('db'));
    expect((await GET(new Request('http://admin/api/admin/content/scans'))).status).toBe(500);
  });
});
