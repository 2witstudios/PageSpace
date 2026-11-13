import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSelectRows = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: () => mockSelectRows() }) }) }) },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id' } }));

const gateAvatarBytes = vi.fn();
vi.mock('@/lib/content-safety/avatar-gate-service', () => ({ gateAvatarBytes: (...args: unknown[]) => gateAvatarBytes(...args) }));

import { POST } from '../route';

const SECRET = 'service-secret-that-is-long-enough-123';
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const request = (headers: Record<string, string>, body: BodyInit = BYTES) =>
  new Request('http://web:3000/api/internal/content-safety/avatar-gate', { method: 'POST', headers, body });

describe('POST /api/internal/content-safety/avatar-gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('SERVICE_API_SECRET', SECRET);
    mockSelectRows.mockResolvedValue([{ id: 'user-1' }]);
    gateAvatarBytes.mockResolvedValue({ accept: true, contentHash: 'h', finding: 'clean' });
  });

  it('refuses without the service secret and gates nothing', async () => {
    expect((await POST(request({ 'x-service-user-id': 'user-1' }))).status).toBe(403);
    expect((await POST(request({ 'x-service-secret': 'wrong', 'x-service-user-id': 'user-1' }))).status).toBe(403);
    expect(gateAvatarBytes).not.toHaveBeenCalled();
  });

  it('refuses an unknown uploader', async () => {
    mockSelectRows.mockResolvedValue([]);
    expect((await POST(request({ 'x-service-secret': SECRET, 'x-service-user-id': 'nobody' }))).status).toBe(404);
    expect(gateAvatarBytes).not.toHaveBeenCalled();
  });

  it('gates the bytes and answers only whether they were accepted', async () => {
    gateAvatarBytes.mockResolvedValue({ accept: false, reason: 'held', contentHash: 'h', finding: 'flagged' });
    const response = await POST(request({ 'x-service-secret': SECRET, 'x-service-user-id': 'user-1' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accept: false });
    expect(gateAvatarBytes).toHaveBeenCalledWith(BYTES, 'user-1');
  });

  it('refuses a body larger than an avatar', async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    expect((await POST(request({ 'x-service-secret': SECRET, 'x-service-user-id': 'user-1' }, big))).status).toBe(413);
    expect(gateAvatarBytes).not.toHaveBeenCalled();
  });
});
