import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  withAdminAuth: (handler: (admin: { id: string }, req: Request) => Promise<Response>) =>
    (req: Request) => handler({ id: 'admin-1' }, req),
}));

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@pagespace/lib/audit/audit-query', () => ({ queryAuditEvents: queryMock }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { GET } from '../route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const HASH = 'a'.repeat(64);
const get = (query = '') => GET(new Request(`http://localhost/api/admin/content/blocked-uploads${query}`));

const event = (overrides: Record<string, unknown> = {}) => ({
  id: 'evt-1',
  eventType: 'content.upload.blocked',
  userId: 'user-1',
  resourceType: 'file',
  resourceId: HASH,
  ipAddress: 'ciphertext',
  userAgent: 'Mozilla',
  details: { entryPoint: 'upload.presign', driveId: 'drive-1', filename: 'should-not-pass.png' },
  timestamp: new Date('2026-11-12T00:00:00.000Z'),
  ...overrides,
});

describe('GET /api/admin/content/blocked-uploads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockResolvedValue([event()]);
  });

  it('lists blocked attempts from the content.upload.blocked audit events', async () => {
    const body = await (await get()).json();

    expect(queryMock).toHaveBeenCalledWith({ eventType: 'content.upload.blocked', limit: 100 });
    expect(body.attempts).toEqual([
      {
        id: 'evt-1',
        timestamp: '2026-11-12T00:00:00.000Z',
        userId: 'user-1',
        resourceType: 'file',
        resourceId: HASH,
        entryPoint: 'upload.presign',
        driveId: 'drive-1',
      },
    ]);
  });

  it('audits the read, like the case list and the lookup', async () => {
    await get();
    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        eventType: 'content.case.read',
        userId: 'admin-1',
        resourceType: 'content_blocked_uploads',
        resourceId: 'list',
        details: expect.objectContaining({ action: 'list_blocked_uploads', filtered: false, count: 1 }),
      }),
    );

    await get(`?hash=${HASH}`);
    expect(vi.mocked(auditRequest).mock.calls[1][1]).toMatchObject({ resourceId: HASH, details: { filtered: true } });
  });

  it('filters by content hash, normalising its case', async () => {
    await get(`?hash=${HASH.toUpperCase()}&limit=5`);
    expect(queryMock).toHaveBeenCalledWith({ eventType: 'content.upload.blocked', resourceId: HASH, limit: 5 });
  });

  it('rejects a filter that is not a content hash', async () => {
    const res = await get('?hash=not-a-hash');
    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('passes on only the known ID fields of an event, not arbitrary details, IP or user agent', async () => {
    const json = JSON.stringify(await (await get()).json());
    expect(json).not.toContain('should-not-pass.png');
    expect(json).not.toContain('ciphertext');
    expect(json).not.toContain('Mozilla');
  });

  it('marks an unverifiable reference with its reason', async () => {
    queryMock.mockResolvedValue([
      event({ resourceType: 'page', resourceId: 'page-9', details: { entryPoint: 'page.copy', reason: 'unverifiable_file_reference' } }),
    ]);
    const body = await (await get()).json();
    expect(body.attempts[0]).toMatchObject({ resourceType: 'page', resourceId: 'page-9', reason: 'unverifiable_file_reference' });
  });
});
