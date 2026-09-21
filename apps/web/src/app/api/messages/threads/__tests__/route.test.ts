/**
 * PII decryption tests for GET /api/messages/threads.
 * The DM thread list must decrypt each unique counterpart's name/email once
 * per request via decryptUsersByIdOnce, not once per conversation row
 * (GDPR #965 perf remediation round 2).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db/db', () => ({
  db: { execute: vi.fn() },
}));

vi.mock('@pagespace/db/operators', () => {
  // Capture the literal text chunks so tests can identify which CTE ran.
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ __sqlText: strings.join('?'), __values: values }),
    { param: (value: unknown) => ({ __param: value }) },
  );
  return { sql };
});

// The one member-drive set (org-aware; owned drives plus accepted rows while dark).
vi.mock('@pagespace/lib/permissions/member-drives', () => ({
  getMemberDriveIds: vi.fn(async () => ['drive_member']),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getBatchPagePermissions: vi.fn(async (_userId: string, pageIds: string[]) =>
    new Map(pageIds.map((id) => [id, { canView: true, canEdit: false, canShare: false, canDelete: false }]))),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

// Wrap (not replace) the real decryptUsersByIdOnce so call counts can be
// asserted at the route's call boundary — proves the route batches decryption
// once per request instead of once per row. A bare `vi.spyOn` doesn't work
// here because `@pagespace/lib` resolves to its built CJS dist output, and the
// per-row-dedup internals (decryptUserRow -> decryptField) are a *nested*
// require inside that compiled module, invisible to any mock at this level.
vi.mock('@pagespace/lib/auth/user-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/auth/user-repository')>();
  return { ...actual, decryptUsersByIdOnce: vi.fn(actual.decryptUsersByIdOnce) };
});

import { GET } from '../route';
import { getMemberDriveIds } from '@pagespace/lib/permissions/member-drives';
import { getBatchPagePermissions } from '@pagespace/lib/permissions/permissions';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { decryptUsersByIdOnce } from '@pagespace/lib/auth/user-repository';
import { encryptField } from '@pagespace/lib/encryption/field-crypto';

const mockUserId = 'user_123';
const otherUserId = 'user_other';

const mockAuth = () => {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
    userId: mockUserId,
    tokenVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'test-session',
    role: 'user' as const,
    adminRoleVersion: 0,
  });
};

const dmRow = (overrides: Record<string, unknown>) => ({
  id: 'conv_1',
  participant1Id: mockUserId,
  participant2Id: otherUserId,
  lastMessageAt: '2026-05-03T00:00:00.000Z',
  lastMessagePreview: 'hi',
  participant1LastRead: null,
  participant2LastRead: null,
  createdAt: '2026-05-01T00:00:00.000Z',
  last_read: null,
  other_user_id: otherUserId,
  other_user_name: 'Other',
  other_user_email: 'other@example.com',
  other_user_image: null,
  other_user_username: 'other',
  other_user_display_name: null,
  other_user_avatar_url: null,
  unread_count: '0',
  ...overrides,
});

const channelRow = {
  id: 'ch_1',
  title: 'general',
  driveId: 'drv_1',
  drive_name: 'Workspace',
  updatedAt: '2026-05-02T00:00:00.000Z',
  last_message: 'hello',
  last_message_at: '2026-05-02T00:00:00.000Z',
};

const isDmQuery = (arg: unknown) =>
  typeof arg === 'object' && arg !== null && '__sqlText' in arg &&
  String((arg as { __sqlText: string }).__sqlText).includes('dm_conversations');

const mockExecute = (dmRows: unknown[], channelRows: unknown[]) => {
  (db.execute as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (arg: unknown) => {
    if (isDmQuery(arg)) return { rows: dmRows };
    return { rows: channelRows };
  });
};

describe('GET /api/messages/threads PII decryption dedup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('decrypts one counterpart repeated across DM rows only once (dedup)', async () => {
    const encryptedName = await encryptField('Real Name');
    const encryptedEmail = await encryptField('real@example.com');
    const dmRows = Array.from({ length: 4 }, (_, i) =>
      dmRow({ id: `conv_${i}`, other_user_name: encryptedName, other_user_email: encryptedEmail })
    );
    mockExecute(dmRows, [channelRow]);

    const response = await GET(new Request('http://localhost/api/messages/threads'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.dms).toHaveLength(4);
    for (const dm of body.dms) {
      expect(dm.otherUser.name).toBe('Real Name');
      expect(dm.otherUser.email).toBe('real@example.com');
    }
    // Channels carry no PII columns; the request makes exactly one batched
    // decrypt call for the DM rows, not one per of the 4 rows.
    expect(vi.mocked(decryptUsersByIdOnce)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(decryptUsersByIdOnce).mock.calls[0][0]).toHaveLength(4);
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0].title).toBe('general');
  });

  it('passes through legacy plaintext name/email unchanged', async () => {
    mockExecute([dmRow({})], []);

    const response = await GET(new Request('http://localhost/api/messages/threads'));
    const body = await response.json();

    expect(body.dms[0].otherUser.name).toBe('Other');
    expect(body.dms[0].otherUser.email).toBe('other@example.com');
  });

  it('does not crash when a counterpart user row is gone (deleted user)', async () => {
    mockExecute([dmRow({ other_user_id: null, other_user_name: null, other_user_email: null })], []);

    const response = await GET(new Request('http://localhost/api/messages/threads'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.dms[0].otherUser.name).toBeNull();
    expect(body.dms[0].otherUser.email).toBeNull();
  });
});

describe('GET /api/messages/threads channel access (B7c)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  const channelSql = () =>
    vi.mocked(db.execute).mock.calls.map(([arg]) => arg as unknown as { __sqlText: string; __values: unknown[] })
      .find((arg) => !isDmQuery(arg)) as { __sqlText: string; __values: unknown[] };

  it('DRV-5 (partial) X-6 (partial) takes its candidate drives from the org-aware member-drive set; the channel SQL reads neither drive_members nor drives.ownerId', async () => {
    mockExecute([], [channelRow]);

    const response = await GET(new Request('http://localhost/api/messages/threads'));

    expect(response.status).toBe(200);
    expect(getMemberDriveIds).toHaveBeenCalledWith(mockUserId, { includeTrashed: true });
    const { __sqlText, __values } = channelSql();
    expect(__sqlText).not.toMatch(/drive_members/);
    expect(__sqlText).not.toMatch(/"ownerId"/);
    expect(__values).toContainEqual({ __param: ['drive_member'] });
  });

  it('X-6 (partial) lists only the channels getBatchPagePermissions lets the caller view: a pending invitee, a stale org row or a private channel sees nothing', async () => {
    mockExecute([], [channelRow, { ...channelRow, id: 'ch_secret', title: 'secret' }]);
    vi.mocked(getBatchPagePermissions).mockResolvedValueOnce(new Map([
      ['ch_1', { canView: true, canEdit: false, canShare: false, canDelete: false }],
      ['ch_secret', { canView: false, canEdit: false, canShare: false, canDelete: false }],
    ]));

    const body = await (await GET(new Request('http://localhost/api/messages/threads'))).json();

    expect(body.channels.map((c: { id: string }) => c.id)).toEqual(['ch_1']);
    expect(getBatchPagePermissions).toHaveBeenCalledWith(mockUserId, ['ch_1', 'ch_secret']);
  });
});

// The channel list used to be decided entirely by SQL that matched ANY
// drive_members row — no acceptedAt filter — so a user holding a pending,
// unaccepted invite saw every channel in that drive together with its latest
// message. The candidate query stays a candidate filter; the canonical
// getBatchPagePermissions (which requires an accepted membership) decides.
describe('GET /api/messages/threads channel access — pending invites', () => {
  const view = (canView: boolean) => ({ canView, canEdit: false, canShare: false, canDelete: false });
  const pendingDriveChannel = { ...channelRow, id: 'ch_pending', driveId: 'drv_pending', last_message: 'secret' };
  const acceptedDriveChannel = { ...channelRow, id: 'ch_accepted', driveId: 'drv_accepted' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it.each(['ADMIN', 'MEMBER'])('omits channels of a drive where the %s invite is still pending', async () => {
    mockExecute([], [pendingDriveChannel, acceptedDriveChannel]);
    vi.mocked(getBatchPagePermissions).mockResolvedValue(
      new Map([['ch_pending', view(false)], ['ch_accepted', view(true)]]),
    );

    const response = await GET(new Request('http://localhost/api/messages/threads'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.channels.map((c: { id: string }) => c.id)).toEqual(['ch_accepted']);
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(getBatchPagePermissions).toHaveBeenCalledWith(mockUserId, ['ch_pending', 'ch_accepted']);
  });

  it('lists the same channel once the invite is accepted', async () => {
    mockExecute([], [pendingDriveChannel]);
    vi.mocked(getBatchPagePermissions).mockResolvedValue(new Map([['ch_pending', view(true)]]));

    const response = await GET(new Request('http://localhost/api/messages/threads'));
    const body = await response.json();

    expect(body.channels.map((c: { id: string }) => c.id)).toEqual(['ch_pending']);
    expect(body.channels[0].lastMessage).toBe('secret');
  });

  it('omits a channel the resolver has no answer for (fail closed)', async () => {
    mockExecute([], [pendingDriveChannel]);
    vi.mocked(getBatchPagePermissions).mockResolvedValue(new Map());

    const response = await GET(new Request('http://localhost/api/messages/threads'));
    const body = await response.json();

    expect(body.channels).toEqual([]);
  });

  it('skips the permission lookup when there are no candidate channels', async () => {
    mockExecute([], []);

    const response = await GET(new Request('http://localhost/api/messages/threads'));
    const body = await response.json();

    expect(body.channels).toEqual([]);
    expect(getBatchPagePermissions).not.toHaveBeenCalled();
  });
});
