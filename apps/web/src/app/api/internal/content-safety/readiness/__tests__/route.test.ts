import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSelectRows = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: () => mockSelectRows() }) }) }) },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', role: 'role', suspendedAt: 'suspendedAt' } }));

import { GET } from '../route';

const SECRET = 'service-secret-that-is-long-enough-123';
const request = (headers: Record<string, string>) => new Request('http://web:3000/api/internal/content-safety/readiness', { headers });
const admin = { 'x-service-secret': SECRET, 'x-service-user-id': 'admin-1' };

describe('GET /api/internal/content-safety/readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv('SERVICE_API_SECRET', SECRET);
    mockSelectRows.mockResolvedValue([{ role: 'admin', suspendedAt: null }]);
  });

  it('needs the service secret and an active admin', async () => {
    expect((await GET(request({ 'x-service-user-id': 'admin-1' }))).status).toBe(403);
    mockSelectRows.mockResolvedValue([{ role: 'user', suspendedAt: null }]);
    expect((await GET(request(admin))).status).toBe(403);
    mockSelectRows.mockResolvedValue([{ role: 'admin', suspendedAt: new Date() }]);
    expect((await GET(request(admin))).status).toBe(403);
  });

  it('answers booleans and the mode, never a value', async () => {
    vi.stubEnv('CONTENT_SCAN_MODE', 'shadow');
    vi.stubEnv('HIVE_API_KEY', 'hive-secret-key');
    vi.stubEnv('EVIDENCE_BUCKET', 'evidence-bucket-name');
    vi.stubEnv('ABUSE_EMAIL', '');
    const response = await GET(request(admin));
    const body = await response.json();
    expect(body).toEqual({
      onPrem: false,
      mode: 'shadow',
      problems: [],
      hiveKeySet: true,
      evidenceBucketSet: true,
      abuseEmailSet: false,
      publishBucketSet: expect.any(Boolean),
      allowUnclassifiedVideo: false,
    });
    expect(JSON.stringify(body)).not.toMatch(/hive-secret-key|evidence-bucket-name/);
  });

  it('reports on-prem as off', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'onprem');
    vi.stubEnv('CONTENT_SCAN_MODE', 'enforce');
    expect(await (await GET(request(admin))).json()).toMatchObject({ onPrem: true, mode: 'off' });
  });
});
