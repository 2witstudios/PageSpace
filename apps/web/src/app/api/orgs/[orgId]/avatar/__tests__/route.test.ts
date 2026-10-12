/**
 * ORG-1: the org avatar is an image uploaded to PageSpace and served by PageSpace to members only.
 * Authorization is real (requireOrgRole over a faked membership lookup); storage (processor, S3)
 * and the repository are faked at their boundaries.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';
import type { OrgRole } from '@pagespace/db/schema/organizations';

const s3 = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn(() => false) }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/repository', () => ({
  findMembershipRole: vi.fn(),
  setOrganizationAvatar: vi.fn(),
}));
vi.mock('@pagespace/lib/services/validated-service-token', () => ({
  createOrgServiceToken: vi.fn().mockResolvedValue({ token: 'ps_svc_org', grantedScopes: ['org-avatars:write'] }),
}));
vi.mock('@pagespace/lib/organizations/org-change-events', () => ({ announceOrgChange: vi.fn(async () => undefined) }));
vi.mock('@/lib/presigned-url', () => ({ getS3Client: () => s3, getS3Bucket: () => 'bucket' }));

import { POST, DELETE } from '../route';
import { GET } from '../[filename]/route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { findMembershipRole, setOrganizationAvatar } from '@pagespace/lib/organizations/repository';
import { createOrgServiceToken } from '@pagespace/lib/services/validated-service-token';
import { announceOrgChange } from '@pagespace/lib/organizations/org-change-events';

const ORG = 'org_nw';
const session: SessionAuthResult = { userId: 'u_priya', tokenVersion: 0, tokenType: 'session', sessionId: 's', role: 'user', adminRoleVersion: 0 };
const params = { params: Promise.resolve({ orgId: ORG }) };
const fileParams = (filename: string) => ({ params: Promise.resolve({ orgId: ORG, filename }) });
const fetchMock = vi.fn();

/** jsdom's Request.formData() cannot parse a multipart body (account avatar route test does the same). */
const upload = (file: File | null) => {
  const request = new Request(`https://example.test/api/orgs/${ORG}/avatar`, { method: 'POST' });
  const form = { get: (name: string) => (name === 'file' ? file : null) };
  return Object.assign(request, { formData: vi.fn().mockResolvedValue(form) });
};
const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', { type: 'image/png' });
const asRole = (role: OrgRole | null) => vi.mocked(findMembershipRole).mockResolvedValue(role);
const OLD = `/api/orgs/${ORG}/avatar/avatar-old111.png`;
const NEW_FILE = 'avatar-new222.png';
const NEW = `/api/orgs/${ORG}/avatar/${NEW_FILE}`;
/** The order storage writes and column switches happen in. */
const calls: string[] = [];
const stored = { avatarUrl: null as string | null };

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session);
  stored.avatarUrl = OLD;
  fetchMock.mockImplementation(async (_url: string, init: { method: string }) => {
    calls.push(`storage ${init.method} ${_url.replace(/^.*\/api\/org-avatar\//, '')}`);
    return new Response(JSON.stringify(init.method === 'POST' ? { filename: NEW_FILE } : { success: true }), { status: 200 });
  });
  vi.mocked(setOrganizationAvatar).mockImplementation(async (orgId, avatarUrl) => {
    calls.push(`column ${avatarUrl}`);
    const previousAvatarUrl = stored.avatarUrl;
    stored.avatarUrl = avatarUrl;
    return {
      ok: true,
      previousAvatarUrl,
      organization: { id: orgId, name: 'Northwind Labs', slug: 'northwind', avatarUrl, ownerId: 'u_jono', stripeCustomerId: null, stripeSubscriptionId: null, seatAutoAdd: false, createdAt: new Date(), updatedAt: new Date() },
    };
  });
});

describe('ORG-1 (partial) uploading and removing the org avatar', () => {
  it('an Admin uploads an image through an org-bound token: the new file is written, then the org is switched to it, then the file it replaced is deleted', async () => {
    asRole('ADMIN');
    const res = await POST(upload(png()), params);
    expect(res.status).toBe(200);
    expect((await res.json()).organization.avatarUrl).toBe(NEW);
    expect(createOrgServiceToken).toHaveBeenCalledWith('u_priya', ORG, ['org-avatars:write'], expect.any(String));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`/api/org-avatar/${ORG}$`)), expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer ps_svc_org' } }));
    expect(calls).toEqual([`storage POST ${ORG}`, `column ${NEW}`, `storage DELETE ${ORG}/avatar-old111.png`]);
    // X-4: the picker and crumb show the new mark without a refresh.
    expect(announceOrgChange).toHaveBeenCalledWith(ORG, 'profile');
  });

  it('a first upload deletes nothing; an upload the org could not be switched to removes its own new file', async () => {
    asRole('ADMIN');
    stored.avatarUrl = null;
    await POST(upload(png()), params);
    expect(calls).toEqual([`storage POST ${ORG}`, `column ${NEW}`]);

    calls.length = 0;
    vi.mocked(setOrganizationAvatar).mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    expect((await POST(upload(png()), params)).status).toBe(404);
    expect(calls).toEqual([`storage POST ${ORG}`, `storage DELETE ${ORG}/${NEW_FILE}`]);
  });

  it('a plain Member is refused and a non-member gets 404; nothing is stored', async () => {
    asRole('MEMBER');
    expect((await POST(upload(png()), params)).status).toBe(403);
    expect((await DELETE(new Request('https://example.test', { method: 'DELETE' }), params)).status).toBe(403);
    asRole(null);
    expect((await POST(upload(png()), params)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setOrganizationAvatar).not.toHaveBeenCalled();
  });

  it('a missing file, a non-raster type (SVG) or an oversize image is refused before anything is stored', async () => {
    asRole('OWNER');
    expect((await POST(upload(null), params)).status).toBe(400);
    expect((await POST(upload(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' })), params)).status).toBe(400);
    expect((await POST(upload(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })), params)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a filename the storage service answers with that is not an org avatar file is never recorded', async () => {
    asRole('ADMIN');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ filename: '../../avatars/u1/avatar.png' }), { status: 200 }));
    expect((await POST(upload(png()), params)).status).toBe(502);
    expect(setOrganizationAvatar).not.toHaveBeenCalled();
  });

  it('removing clears the avatar first, then deletes the file it pointed to (and nothing when there was none)', async () => {
    asRole('ADMIN');
    const res = await DELETE(new Request('https://example.test', { method: 'DELETE' }), params);
    expect(res.status).toBe(200);
    expect(calls).toEqual(['column null', `storage DELETE ${ORG}/avatar-old111.png`]);

    calls.length = 0;
    await DELETE(new Request('https://example.test', { method: 'DELETE' }), params);
    expect(calls).toEqual(['column null']);
  });
});

describe('ORG-1 (partial) serving the org avatar', () => {
  it('a member gets the image bytes from the org\'s own folder; a non-member gets 404 and nothing is read', async () => {
    asRole('MEMBER');
    s3.send.mockResolvedValue({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } });
    const res = await GET(new Request('https://example.test'), fileParams('avatar-abc123.png'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(s3.send).toHaveBeenCalledWith(expect.objectContaining({ input: { Bucket: 'bucket', Key: `org-avatars/${ORG}/avatar-abc123.png` } }));

    s3.send.mockClear();
    asRole(null);
    expect((await GET(new Request('https://example.test'), fileParams('avatar-abc123.png'))).status).toBe(404);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('any filename other than an org avatar file is refused (no traversal into other storage)', async () => {
    asRole('MEMBER');
    for (const filename of ['../avatars/u1/avatar-abc123.png', 'avatar-abc123.svg', 'avatar.png', 'avatar-abc123.png.html']) {
      expect((await GET(new Request('https://example.test'), fileParams(filename))).status).toBe(400);
    }
    expect(s3.send).not.toHaveBeenCalled();
  });
});
