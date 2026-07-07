/**
 * Tests for /api/inbox ?type filter (dm | channel | all).
 * Asserts the route only fetches the requested feed kind so cursor pagination
 * stays correct per-feed.
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
  const sql = (strings: TemplateStringsArray, ..._values: unknown[]) => ({
    __sqlText: strings.join('?'),
  });
  return { sql };
});

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getBatchPagePermissions: vi.fn(),
}));

// Wrap (not replace) the real decryptUsersByIdOnce so call counts can be
// asserted at the route's call boundary — proves the route batches decryption
// once per request instead of once per row (the actual regression this test
// guards). A bare `vi.spyOn` doesn't work here because `@pagespace/lib`
// resolves to its built CJS dist output, and the per-row-dedup internals
// (decryptUserRow -> decryptField) are a *nested* require inside that
// compiled module, invisible to any mock declared at this level.
vi.mock('@pagespace/lib/auth/user-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/auth/user-repository')>();
  return { ...actual, decryptUsersByIdOnce: vi.fn(actual.decryptUsersByIdOnce) };
});

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { getBatchPagePermissions } from '@pagespace/lib/permissions/permissions';
import { decryptUsersByIdOnce } from '@pagespace/lib/auth/user-repository';
import { encryptField } from '@pagespace/lib/encryption/field-crypto';

const mockUserId = 'user_123';

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

const dmRow = {
  id: 'dm_1',
  last_message_at: '2026-05-03T00:00:00.000Z',
  last_message: 'hi',
  other_user_name: 'Alice',
  other_user_display_name: 'Alice',
  other_user_avatar_url: null,
  other_user_image: '/api/avatar/alice/avatar.png?t=1',
  unread_count: '0',
};

const channelRow = {
  id: 'ch_1',
  name: 'general',
  drive_id: 'drv_1',
  drive_name: 'Workspace',
  last_message: 'hello',
  last_message_at: '2026-05-02T00:00:00.000Z',
  sender_name: 'Bob',
  unread_count: '0',
};

const isDmQuery = (arg: unknown) =>
  typeof arg === 'object' && arg !== null && '__sqlText' in arg &&
  String((arg as { __sqlText: string }).__sqlText).includes('dm_conversations');

const isChannelQuery = (arg: unknown) =>
  typeof arg === 'object' && arg !== null && '__sqlText' in arg &&
  String((arg as { __sqlText: string }).__sqlText).includes("p.type = 'CHANNEL'");

const setupDb = () => {
  // db.execute returns a complex Drizzle PgRaw type — for these tests we only need rows.
  (db.execute as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (arg: unknown) => {
    if (isDmQuery(arg)) return { rows: [dmRow] };
    if (isChannelQuery(arg)) return { rows: [channelRow] };
    return { rows: [] };
  });
  (getBatchPagePermissions as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Map([['ch_1', { canView: true, canEdit: false, canShare: false, canDelete: false }]])
  );
};

describe('GET /api/inbox ?type filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    setupDb();
  });

  it('returns DMs and channels when type is omitted (default=all)', async () => {
    const res = await GET(new Request('http://localhost/api/inbox?limit=20'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const types = body.items.map((i: { type: string }) => i.type).sort();
    expect(types).toEqual(['channel', 'dm']);
    expect(vi.mocked(db.execute)).toHaveBeenCalledTimes(2);
  });

  it('returns only DMs when type=dm', async () => {
    const res = await GET(new Request('http://localhost/api/inbox?type=dm&limit=20'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].type).toBe('dm');
    // Only the DM CTE runs — the channel CTE must be skipped.
    expect(vi.mocked(db.execute)).toHaveBeenCalledTimes(1);
    const sqlArg = vi.mocked(db.execute).mock.calls[0][0];
    expect(isDmQuery(sqlArg)).toBe(true);
  });

  it('uses users.image as the DM avatar when the profile avatar is blank', async () => {
    const res = await GET(new Request('http://localhost/api/inbox?type=dm&limit=20'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items[0].avatarUrl).toBe('/api/avatar/alice/avatar.png?t=1');
  });

  it('returns only channels when type=channel', async () => {
    const res = await GET(new Request('http://localhost/api/inbox?type=channel&limit=20'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].type).toBe('channel');
    expect(vi.mocked(db.execute)).toHaveBeenCalledTimes(1);
    const sqlArg = vi.mocked(db.execute).mock.calls[0][0];
    expect(isChannelQuery(sqlArg)).toBe(true);
  });

  it('rejects type=dm combined with driveId (DMs are user-scoped)', async () => {
    const res = await GET(new Request('http://localhost/api/inbox?type=dm&driveId=drv_1'));
    expect(res.status).toBe(400);
    expect(vi.mocked(db.execute)).not.toHaveBeenCalled();
  });

  it('ignores unknown type values and falls back to all', async () => {
    const res = await GET(new Request('http://localhost/api/inbox?type=bogus'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const types = body.items.map((i: { type: string }) => i.type).sort();
    expect(types).toEqual(['channel', 'dm']);
  });
});

describe('GET /api/inbox PII decryption dedup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  const allowChannels = (ids: string[]) => {
    (getBatchPagePermissions as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map(ids.map((id) => [id, { canView: true, canEdit: false, canShare: false, canDelete: false }]))
    );
  };

  const mockExecute = (dmRows: unknown[], channelRows: unknown[]) => {
    (db.execute as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (arg: unknown) => {
      if (isDmQuery(arg)) return { rows: dmRows };
      if (isChannelQuery(arg)) return { rows: channelRows };
      return { rows: [] };
    });
  };

  it('decrypts one encrypted sender shared across many channel rows only once (dedup)', async () => {
    const encryptedSender = await encryptField('Real Sender');
    const channelRows = Array.from({ length: 5 }, (_, i) => ({
      ...channelRow,
      id: `ch_${i}`,
      sender_name: encryptedSender,
    }));
    mockExecute([], channelRows);
    allowChannels(channelRows.map((row) => row.id as string));

    const res = await GET(new Request('http://localhost/api/inbox?type=channel&limit=20'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items).toHaveLength(5);
    for (const item of body.items) {
      expect(item.lastMessageSender).toBe('Real Sender');
    }
    // Decryption is batched once per request (dedup happens inside), not
    // once per of the 5 channel rows.
    expect(vi.mocked(decryptUsersByIdOnce)).toHaveBeenCalledTimes(1);
  });

  it('decrypts DM sender names and channel sender names in ONE batch for a type=all request', async () => {
    const encryptedDmName = await encryptField('Dm Counterpart');
    const encryptedSender = await encryptField('Channel Sender');
    mockExecute(
      [{ ...dmRow, other_user_display_name: null, other_user_name: encryptedDmName }],
      [{ ...channelRow, sender_name: encryptedSender }]
    );
    allowChannels(['ch_1']);

    const res = await GET(new Request('http://localhost/api/inbox?limit=20'));
    const body = await res.json();

    expect(res.status).toBe(200);
    const dm = body.items.find((i: { type: string }) => i.type === 'dm');
    const channel = body.items.find((i: { type: string }) => i.type === 'channel');
    expect(dm.name).toBe('Dm Counterpart');
    expect(channel.lastMessageSender).toBe('Channel Sender');
    expect(vi.mocked(decryptUsersByIdOnce)).toHaveBeenCalledTimes(1);
  });

  it('decrypts a repeated encrypted sender once in the drive-scoped inbox', async () => {
    const encryptedSender = await encryptField('Drive Sender');
    const channelRows = Array.from({ length: 3 }, (_, i) => ({
      ...channelRow,
      id: `ch_${i}`,
      sender_name: encryptedSender,
    }));
    mockExecute([], channelRows);
    allowChannels(channelRows.map((row) => row.id as string));

    const res = await GET(new Request('http://localhost/api/inbox?driveId=drv_1&limit=20'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items).toHaveLength(3);
    for (const item of body.items) {
      expect(item.lastMessageSender).toBe('Drive Sender');
    }
    expect(vi.mocked(decryptUsersByIdOnce)).toHaveBeenCalledTimes(1);
  });

  it('passes through plaintext AI sender names and profile display names unchanged', async () => {
    const encryptedDmName = await encryptField('Hidden Name');
    mockExecute(
      // displayName present: users.name must not be needed (nor surfaced).
      [{ ...dmRow, other_user_display_name: 'Profile Display', other_user_name: encryptedDmName }],
      // COALESCE'd AI senderName is plaintext and must pass through unchanged.
      [{ ...channelRow, sender_name: 'AI Agent' }]
    );
    allowChannels(['ch_1']);

    const res = await GET(new Request('http://localhost/api/inbox?limit=20'));
    const body = await res.json();

    expect(res.status).toBe(200);
    const dm = body.items.find((i: { type: string }) => i.type === 'dm');
    const channel = body.items.find((i: { type: string }) => i.type === 'channel');
    expect(dm.name).toBe('Profile Display');
    expect(channel.lastMessageSender).toBe('AI Agent');
  });

  it('keeps a null last-message sender null (channel with no messages)', async () => {
    mockExecute([], [{ ...channelRow, sender_name: null, last_message: null, last_message_at: null }]);
    allowChannels(['ch_1']);

    const res = await GET(new Request('http://localhost/api/inbox?type=channel&limit=20'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items[0].lastMessageSender).toBeNull();
  });
});
