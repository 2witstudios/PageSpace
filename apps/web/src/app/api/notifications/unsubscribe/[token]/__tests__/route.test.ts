import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, POST } from '../route';

const mockTokenFindFirst = vi.hoisted(() => vi.fn());
const mockPrefFindFirst = vi.hoisted(() => vi.fn());
const mockInsert = vi.hoisted(() => vi.fn());
const mockInsertValues = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockUpdateSet = vi.hoisted(() => vi.fn());
const mockUpdateWhere = vi.hoisted(() => vi.fn());

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
  emailUnsubscribeTokens: { tokenHash: 'tokenHash', expiresAt: 'expiresAt', usedAt: 'usedAt' },
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

/** A live, unused token for the given notification type. */
function mockValidToken(notificationType: string, userId = 'u1') {
  mockTokenFindFirst.mockResolvedValue({ userId, notificationType });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WEB_APP_URL = 'https://app.pagespace.ai';

  mockUpdate.mockReturnValue({ set: mockUpdateSet });
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockUpdateWhere.mockResolvedValue(undefined);
  mockInsert.mockReturnValue({ values: mockInsertValues });
  mockInsertValues.mockResolvedValue(undefined);
  mockPrefFindFirst.mockResolvedValue(undefined);
});

describe('GET /api/notifications/unsubscribe/[token]', () => {
  it('given a valid PRODUCT_UPDATE token, should record the opt-out and redirect to the confirmation page', async () => {
    mockValidToken('PRODUCT_UPDATE');

    const res = await GET(req(), params('tok'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'https://app.pagespace.ai/unsubscribe-success?type=PRODUCT_UPDATE',
    );
    expect(mockInsertValues).toHaveBeenCalledWith({
      userId: 'u1',
      notificationType: 'PRODUCT_UPDATE',
      emailEnabled: false,
    });
  });

  it('given an existing preference, should flip it off rather than insert a duplicate', async () => {
    mockValidToken('PRODUCT_UPDATE');
    mockPrefFindFirst.mockResolvedValue({ id: 'p1', emailEnabled: true });

    await GET(req(), params('tok'));

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ emailEnabled: false }),
    );
  });

  it('given an invalid or expired token, should 400 and change nothing', async () => {
    mockTokenFindFirst.mockResolvedValue(undefined);

    const res = await GET(req(), params('nope'));

    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('given a token carrying an unknown notification type, should 400 WITHOUT writing a preference', async () => {
    // The type is validated before the write. Writing first and rejecting after
    // would persist a preference row for a type the app does not recognize.
    mockValidToken('NOT_A_REAL_TYPE');

    const res = await GET(req(), params('tok'));

    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('should consume the one-time token by stamping usedAt', async () => {
    mockValidToken('PRODUCT_UPDATE');

    await GET(req(), params('tok'));

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ usedAt: expect.any(Date) }),
    );
  });
});

describe('POST /api/notifications/unsubscribe/[token] (RFC 8058 one-click)', () => {
  it('given a valid token, should record the opt-out and return 200 rather than a redirect', async () => {
    // Mail clients POST straight from the List-Unsubscribe header and never see
    // our pages, so a redirect would be meaningless to them.
    mockValidToken('PRODUCT_UPDATE');

    const res = await POST(req(), params('tok'));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ unsubscribed: true });
    expect(mockInsertValues).toHaveBeenCalledWith({
      userId: 'u1',
      notificationType: 'PRODUCT_UPDATE',
      emailEnabled: false,
    });
  });

  it('given an invalid token, should 400 and change nothing', async () => {
    mockTokenFindFirst.mockResolvedValue(undefined);

    const res = await POST(req(), params('nope'));

    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('should have the same effect as GET — the bulk-mail button must not be a weaker opt-out', async () => {
    mockValidToken('NEW_DIRECT_MESSAGE');

    const res = await POST(req(), params('tok'));

    expect(res.status).toBe(200);
    expect(mockInsertValues).toHaveBeenCalledWith({
      userId: 'u1',
      notificationType: 'NEW_DIRECT_MESSAGE',
      emailEnabled: false,
    });
  });
});
