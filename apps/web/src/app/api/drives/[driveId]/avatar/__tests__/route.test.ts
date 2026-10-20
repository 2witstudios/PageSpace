/**
 * A drive's avatar is an image uploaded to PageSpace and served by PageSpace to whoever can reach the
 * drive. The drive authority checks, storage (processor, S3) and the repository are faked at their
 * boundaries; the shared avatar steps (lib/avatars/avatar-route.ts) run for real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

const s3 = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(() => false),
  isPrincipalDriveOwnerOrAdmin: vi.fn(),
  getPrincipalDriveAccess: vi.fn(),
}));
vi.mock('@/lib/auth/request-actor', () => ({
  actorFromAuth: vi.fn((auth: { userId: string }) => ({ via: 'credential', userId: auth.userId })),
  deniedResponse: vi.fn((_actor: unknown, _driveId: string, response: Response) => response),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/services/drive-service', () => ({ setDriveAvatar: vi.fn() }));
vi.mock('@pagespace/lib/services/drive-member-service', () => ({ getDriveRecipientUserIds: vi.fn(async () => ['u_priya', 'u_sam']) }));
vi.mock('@pagespace/lib/services/validated-service-token', () => ({
  createDriveServiceToken: vi.fn().mockResolvedValue({ token: 'ps_svc_drive', grantedScopes: ['drive-avatars:write'] }),
}));
vi.mock('@/lib/websocket', () => ({
  broadcastDriveEvent: vi.fn(async () => undefined),
  createDriveEventPayload: vi.fn((driveId: string, operation: string, data: object) => ({ driveId, operation, ...data })),
}));
vi.mock('@/lib/presigned-url', () => ({ getS3Client: () => s3, getS3Bucket: () => 'bucket' }));

import { POST, DELETE } from '../route';
import { GET } from '../[filename]/route';
import { authenticateRequestWithOptions, getPrincipalDriveAccess, isPrincipalDriveOwnerOrAdmin } from '@/lib/auth';
import { setDriveAvatar } from '@pagespace/lib/services/drive-service';
import { createDriveServiceToken } from '@pagespace/lib/services/validated-service-token';
import { broadcastDriveEvent } from '@/lib/websocket';

const DRIVE = 'drv_1';
const session: SessionAuthResult = { userId: 'u_priya', tokenVersion: 0, tokenType: 'session', sessionId: 's', role: 'user', adminRoleVersion: 0 };
const params = { params: Promise.resolve({ driveId: DRIVE }) };
const fileParams = (filename: string) => ({ params: Promise.resolve({ driveId: DRIVE, filename }) });
const fetchMock = vi.fn();

/** jsdom's Request.formData() cannot parse a multipart body (the org avatar route test does the same). */
const upload = (file: File | null) => {
  const request = new Request(`https://example.test/api/drives/${DRIVE}/avatar`, { method: 'POST' });
  const form = { get: (name: string) => (name === 'file' ? file : null) };
  return Object.assign(request, { formData: vi.fn().mockResolvedValue(form) });
};
const remove = () => new Request('https://example.test', { method: 'DELETE' });
const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', { type: 'image/png' });
const OLD = `/api/drives/${DRIVE}/avatar/avatar-old111.png`;
const NEW_FILE = 'avatar-new222.png';
const NEW = `/api/drives/${DRIVE}/avatar/${NEW_FILE}`;
const calls: string[] = [];
const stored = { avatarUrl: null as string | null };

type DriveRow = Awaited<ReturnType<typeof setDriveAvatar>> extends infer R ? R extends { ok: true; drive: infer D } ? D : never : never;

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session);
  vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(true);
  vi.mocked(getPrincipalDriveAccess).mockResolvedValue(true);
  stored.avatarUrl = OLD;
  fetchMock.mockImplementation(async (url: string, init: { method: string }) => {
    calls.push(`storage ${init.method} ${url.replace(/^.*\/api\/drive-avatar\//, '')}`);
    return new Response(JSON.stringify(init.method === 'POST' ? { filename: NEW_FILE } : { success: true }), { status: 200 });
  });
  vi.mocked(setDriveAvatar).mockImplementation(async (driveId, avatarUrl) => {
    calls.push(`column ${avatarUrl}`);
    const previousAvatarUrl = stored.avatarUrl;
    stored.avatarUrl = avatarUrl;
    return { ok: true, previousAvatarUrl, drive: { id: driveId, name: 'Acme', slug: 'acme', avatarUrl } as DriveRow };
  });
});

describe('uploading and removing a drive avatar', () => {
  it('an Owner or Admin uploads through a drive-bound token: new file, then the switch, then the replaced file is deleted, then members refetch', async () => {
    const res = await POST(upload(png()), params);
    expect(res.status).toBe(200);
    expect((await res.json()).drive.avatarUrl).toBe(NEW);
    expect(createDriveServiceToken).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u_priya' }), DRIVE, ['drive-avatars:write'], expect.any(String));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`/api/drive-avatar/${DRIVE}$`)), expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer ps_svc_drive' } }));
    expect(calls).toEqual([`storage POST ${DRIVE}`, `column ${NEW}`, `storage DELETE ${DRIVE}/avatar-old111.png`]);
    expect(broadcastDriveEvent).toHaveBeenCalledWith(expect.objectContaining({ driveId: DRIVE, operation: 'updated' }), ['u_priya', 'u_sam']);
  });

  it('an upload the drive could not be switched to removes its own new file and announces nothing', async () => {
    vi.mocked(setDriveAvatar).mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    expect((await POST(upload(png()), params)).status).toBe(404);
    expect(calls).toEqual([`storage POST ${DRIVE}`, `storage DELETE ${DRIVE}/${NEW_FILE}`]);
    expect(broadcastDriveEvent).not.toHaveBeenCalled();
  });

  it('someone who is not a drive Owner or Admin is refused, and nothing is stored', async () => {
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(false);
    expect((await POST(upload(png()), params)).status).toBe(403);
    expect((await DELETE(remove(), params)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setDriveAvatar).not.toHaveBeenCalled();
  });

  it('a missing file, an SVG or an oversize image is refused before anything is stored', async () => {
    expect((await POST(upload(null), params)).status).toBe(400);
    expect((await POST(upload(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' })), params)).status).toBe(400);
    expect((await POST(upload(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })), params)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a filename the storage service answers with that is not an avatar file is never recorded', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ filename: '../../avatars/u1/avatar.png' }), { status: 200 }));
    expect((await POST(upload(png()), params)).status).toBe(502);
    expect(setDriveAvatar).not.toHaveBeenCalled();
  });

  it('removing clears the avatar first, then deletes the file it pointed to (and nothing when there was none)', async () => {
    expect((await DELETE(remove(), params)).status).toBe(200);
    expect(calls).toEqual(['column null', `storage DELETE ${DRIVE}/avatar-old111.png`]);
    calls.length = 0;
    await DELETE(remove(), params);
    expect(calls).toEqual(['column null']);
  });
});

describe('serving a drive avatar', () => {
  it('someone who can reach the drive gets the bytes from its own folder; anyone else gets 404 and nothing is read', async () => {
    s3.send.mockResolvedValue({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } });
    const res = await GET(new Request('https://example.test'), fileParams('avatar-abc123.webp'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/webp');
    expect(res.headers.get('Cache-Control')).toContain('private');
    expect(s3.send).toHaveBeenCalledWith(expect.objectContaining({ input: { Bucket: 'bucket', Key: `drive-avatars/${DRIVE}/avatar-abc123.webp` } }));

    s3.send.mockClear();
    vi.mocked(getPrincipalDriveAccess).mockResolvedValue(false);
    expect((await GET(new Request('https://example.test'), fileParams('avatar-abc123.webp'))).status).toBe(404);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('any filename other than an avatar file is refused', async () => {
    for (const filename of ['../avatars/u1/avatar-abc123.png', 'avatar-abc123.svg', 'avatar.png']) {
      expect((await GET(new Request('https://example.test'), fileParams(filename))).status).toBe(400);
    }
    expect(s3.send).not.toHaveBeenCalled();
  });
});
