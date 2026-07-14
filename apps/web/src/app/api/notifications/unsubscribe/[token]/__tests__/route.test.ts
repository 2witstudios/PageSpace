import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, POST } from '../route';

const mockTokenFindFirst = vi.hoisted(() => vi.fn());
const mockPrefFindFirst = vi.hoisted(() => vi.fn());
const mockInsert = vi.hoisted(() => vi.fn());
const mockInsertValues = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockUpdateSet = vi.hoisted(() => vi.fn());
const mockUpdateWhere = vi.hoisted(() => vi.fn());
const mockUpdateReturning = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      emailUnsubscribeTokens: { findFirst: mockTokenFindFirst },
      emailNotificationPreferences: { findFirst: mockPrefFindFirst },
    },
    insert: mockInsert,
    update: mockUpdate,
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(() => 'eq'),
  and: vi.fn(() => 'and'),
  gt: vi.fn(() => 'gt'),
  isNull: vi.fn(() => 'isNull'),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  emailUnsubscribeTokens: {
    tokenHash: 'tokenHash',
    expiresAt: 'expiresAt',
    usedAt: 'usedAt',
    userId: 'userId',
    notificationType: 'notificationType',
  },
}));
vi.mock('@pagespace/db/schema/email-notifications', () => ({
  emailNotificationPreferences: { userId: 'userId', notificationType: 'notificationType' },
}));
vi.mock('@pagespace/lib/auth/token-utils', () => ({
  hashToken: vi.fn((t: string) => `hash-${t}`),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn() }));

const params = (token: string) => ({ params: Promise.resolve({ token }) });
const req = () => new Request('https://app.pagespace.ai/api/notifications/unsubscribe/tok');

/** The token row the atomic claim (UPDATE … RETURNING) hands back to POST. */
function tokenClaimSucceeds(notificationType: string, userId = 'u1') {
  mockUpdateReturning.mockResolvedValue([{ userId, notificationType }]);
}

/** Nobody won the claim: token missing, expired, or already used. */
function tokenClaimFails() {
  mockUpdateReturning.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WEB_APP_URL = 'https://app.pagespace.ai';

  mockUpdate.mockReturnValue({ set: mockUpdateSet });
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });
  mockUpdateReturning.mockResolvedValue([]);
  mockInsert.mockReturnValue({ values: mockInsertValues });
  mockInsertValues.mockResolvedValue(undefined);
  mockPrefFindFirst.mockResolvedValue(undefined);
});

describe('GET /api/notifications/unsubscribe/[token]', () => {
  it('given a live token, should send the user to the confirm page WITHOUT unsubscribing them', async () => {
    // The whole point: link scanners and mail gateways GET the URLs they find in
    // an email. If GET unsubscribed, a machine could opt a user out silently.
    mockTokenFindFirst.mockResolvedValue({ userId: 'u1', notificationType: 'PRODUCT_UPDATE' });

    const res = await GET(req(), params('tok'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'https://app.pagespace.ai/unsubscribe?token=tok&type=PRODUCT_UPDATE',
    );
    // Nothing was written, and the one-time token was NOT consumed.
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('given an invalid or expired token, should 400 and change nothing', async () => {
    mockTokenFindFirst.mockResolvedValue(undefined);

    const res = await GET(req(), params('nope'));

    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('given a token carrying an unknown notification type, should 400 without consuming it', async () => {
    mockTokenFindFirst.mockResolvedValue({ userId: 'u1', notificationType: 'NOT_A_REAL_TYPE' });

    const res = await GET(req(), params('tok'));

    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('POST /api/notifications/unsubscribe/[token]', () => {
  it('given a valid token, should record the opt-out and return 200 rather than a redirect', async () => {
    // Mail clients POST straight from the List-Unsubscribe header and never see
    // our pages, so a redirect would be meaningless to them.
    tokenClaimSucceeds('PRODUCT_UPDATE');

    const res = await POST(req(), params('tok'));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      unsubscribed: true,
      notificationType: 'PRODUCT_UPDATE',
    });
    expect(mockInsertValues).toHaveBeenCalledWith({
      userId: 'u1',
      notificationType: 'PRODUCT_UPDATE',
      emailEnabled: false,
    });
  });

  it('should claim the one-time token atomically, so a racing click and one-click POST cannot both win', async () => {
    tokenClaimSucceeds('PRODUCT_UPDATE');

    await POST(req(), params('tok'));

    // The claim is a single gated UPDATE … RETURNING, not read-then-write.
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ usedAt: expect.any(Date) }),
    );
    expect(mockUpdateReturning).toHaveBeenCalled();
  });

  it('given a token already consumed by a concurrent request, should 400 and change nothing', async () => {
    tokenClaimFails();

    const res = await POST(req(), params('tok'));

    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('given an existing preference, should flip it off rather than insert a duplicate', async () => {
    tokenClaimSucceeds('PRODUCT_UPDATE');
    mockPrefFindFirst.mockResolvedValue({ id: 'p1', emailEnabled: true });

    await POST(req(), params('tok'));

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ emailEnabled: false }));
  });

  it('given a token carrying an unknown notification type, should 400 WITHOUT writing a preference', async () => {
    // The type is validated before the write. Writing first and rejecting after
    // would persist a preference row for a type the app does not recognize.
    tokenClaimSucceeds('NOT_A_REAL_TYPE');

    const res = await POST(req(), params('tok'));

    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('should work for any notification type, not just product updates', async () => {
    tokenClaimSucceeds('NEW_DIRECT_MESSAGE');

    const res = await POST(req(), params('tok'));

    expect(res.status).toBe(200);
    expect(mockInsertValues).toHaveBeenCalledWith({
      userId: 'u1',
      notificationType: 'NEW_DIRECT_MESSAGE',
      emailEnabled: false,
    });
  });
});
