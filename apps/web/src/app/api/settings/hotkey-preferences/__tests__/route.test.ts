import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, PATCH, DELETE } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

const mockSelect = vi.hoisted(() => vi.fn());
const mockFrom = vi.hoisted(() => vi.fn());
const mockWhere = vi.hoisted(() => vi.fn());
const mockInsert = vi.hoisted(() => vi.fn());
const mockValues = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockSet = vi.hoisted(() => vi.fn());
const mockReturning = vi.hoisted(() => vi.fn());
const mockFindFirst = vi.hoisted(() => vi.fn());
const mockDelete = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    query: {
      userHotkeyPreferences: {
        findFirst: mockFindFirst,
      },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ field: a, value: b })),
  and: vi.fn((...args) => args),
}));
vi.mock('@pagespace/db/schema/hotkeys', () => ({
  userHotkeyPreferences: { userId: 'userId', hotkeyId: 'hotkeyId' },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@/lib/hotkeys/registry', () => ({
  getHotkeyDefinition: vi.fn((id: string) => {
    if (id === 'tabs.cycle-next' || id === 'tabs.cycle-prev') {
      return { id, label: 'Test', defaultBinding: 'Ctrl+Tab' };
    }
    return undefined;
  }),
}));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// Test fixtures
const mockSessionAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

describe('GET /api/settings/hotkey-preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockResolvedValue([]);

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth('user-1'));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  it('given authenticated user with no preferences, should return empty array', async () => {
    mockWhere.mockResolvedValue([]);

    const request = new Request('https://example.com/api/settings/hotkey-preferences');
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.preferences).toEqual([]);
  });

  it('given authenticated user with preferences, should return their preferences', async () => {
    mockWhere.mockResolvedValue([
      { hotkeyId: 'tabs.cycle-next', binding: 'Alt+Tab' },
    ]);

    const request = new Request('https://example.com/api/settings/hotkey-preferences');
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.preferences).toEqual([
      { hotkeyId: 'tabs.cycle-next', binding: 'Alt+Tab' },
    ]);
  });

  it('given unauthenticated request, should return 401', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));
    vi.mocked(isAuthError).mockReturnValue(true);

    const request = new Request('https://example.com/api/settings/hotkey-preferences');
    const response = await GET(request);

    expect(response.status).toBe(401);
  });
});

describe('PATCH /api/settings/hotkey-preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockReturnValue({ returning: mockReturning });
    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ returning: mockReturning });

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth('user-1'));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  it('given valid hotkeyId and binding, should create new preference', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockReturning.mockResolvedValue([{ hotkeyId: 'tabs.cycle-next', binding: 'Alt+Tab' }]);

    const request = new Request('https://example.com/api/settings/hotkey-preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hotkeyId: 'tabs.cycle-next', binding: 'Alt+Tab' }),
    });

    const response = await PATCH(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.preference.hotkeyId).toBe('tabs.cycle-next');
    expect(body.preference.binding).toBe('Alt+Tab');
  });

  it('given existing preference, should update it', async () => {
    mockFindFirst.mockResolvedValue({ id: 'pref-1', hotkeyId: 'tabs.cycle-next', binding: 'Ctrl+Tab' });
    mockReturning.mockResolvedValue([{ hotkeyId: 'tabs.cycle-next', binding: 'Alt+Tab' }]);

    const request = new Request('https://example.com/api/settings/hotkey-preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hotkeyId: 'tabs.cycle-next', binding: 'Alt+Tab' }),
    });

    const response = await PATCH(request);
    await response.json();

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('given missing hotkeyId, should return 400', async () => {
    const request = new Request('https://example.com/api/settings/hotkey-preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ binding: 'Alt+Tab' }),
    });

    const response = await PATCH(request);

    expect(response.status).toBe(400);
  });

  it('given invalid hotkeyId, should return 400', async () => {
    const request = new Request('https://example.com/api/settings/hotkey-preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hotkeyId: 'invalid.hotkey', binding: 'Alt+Tab' }),
    });

    const response = await PATCH(request);

    expect(response.status).toBe(400);
  });

  it('given a binding that could never match a key event, should return 400', async () => {
    // What the old capture code produced for macOS Option+P.
    const request = new Request('https://example.com/api/settings/hotkey-preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hotkeyId: 'tabs.cycle-next', binding: 'Alt+Π' }),
    });

    const response = await PATCH(request);

    expect(response.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('given a bare key with no modifier, should return 400', async () => {
    const request = new Request('https://example.com/api/settings/hotkey-preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hotkeyId: 'tabs.cycle-next', binding: 'N' }),
    });

    const response = await PATCH(request);

    expect(response.status).toBe(400);
  });

  it('given a bare "+" from the numpad Add key, should return 400', async () => {
    // "+" is both the separator and a key, so this is the one bare binding that
    // can look modified to a naive parser.
    const request = new Request('https://example.com/api/settings/hotkey-preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hotkeyId: 'tabs.cycle-next', binding: '+' }),
    });

    const response = await PATCH(request);

    expect(response.status).toBe(400);
  });

  it('given an empty binding (disable), should accept it', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockReturning.mockResolvedValue([{ hotkeyId: 'tabs.cycle-next', binding: '' }]);

    const request = new Request('https://example.com/api/settings/hotkey-preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hotkeyId: 'tabs.cycle-next', binding: '' }),
    });

    const response = await PATCH(request);

    expect(response.status).toBe(200);
  });
});

describe('DELETE /api/settings/hotkey-preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDelete.mockReturnValue({ where: mockWhere });
    mockWhere.mockResolvedValue(undefined);

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth('user-1'));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  it('given a hotkeyId, should remove the override', async () => {
    const request = new Request('https://example.com/api/settings/hotkey-preferences', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hotkeyId: 'tabs.cycle-next' }),
    });

    const response = await DELETE(request);

    expect(response.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('given no hotkeyId, should return 400', async () => {
    const request = new Request('https://example.com/api/settings/hotkey-preferences', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const response = await DELETE(request);

    expect(response.status).toBe(400);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('given unauthenticated request, should return 401', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));
    vi.mocked(isAuthError).mockReturnValue(true);

    const request = new Request('https://example.com/api/settings/hotkey-preferences', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hotkeyId: 'tabs.cycle-next' }),
    });

    const response = await DELETE(request);

    expect(response.status).toBe(401);
  });
});
