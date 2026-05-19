import { describe, test, beforeEach, vi } from 'vitest';
import { assert } from '@/lib/ai/openai-api/__tests__/riteway';

// --- module mocks (must be hoisted before imports) ---

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => r != null && typeof r === 'object' && 'error' in r),
  getAllowedDriveIds: vi.fn().mockReturnValue([]),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((_col, val) => ({ __eq: val })),
  and: vi.fn((...args) => ({ __and: args })),
  inArray: vi.fn((_col, vals) => ({ __inArray: vals })),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', type: 'pages.type', isTrashed: 'pages.isTrashed', driveId: 'pages.driveId' },
}));

vi.mock('@pagespace/lib/utils/enums', () => ({
  PageType: { AI_CHAT: 'AI_CHAT' },
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn().mockResolvedValue(true),
}));

// --- imports after mocks ---
import { NextResponse } from 'next/server';
import { GET } from '../route';
import { authenticateRequestWithOptions, getAllowedDriveIds } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { inArray } from '@pagespace/db/operators';

const mcpAuth = {
  userId: 'user-1',
  tokenType: 'mcp' as const,
  tokenId: 'token-1',
  allowedDriveIds: [],
  role: 'user' as const,
  tokenVersion: 1,
  adminRoleVersion: 0,
};

const agentPage1 = {
  id: 'page-123',
  type: 'AI_CHAT',
  title: 'Test Agent',
  driveId: 'drive-abc',
  isTrashed: false,
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

const agentPage2 = {
  id: 'page-456',
  type: 'AI_CHAT',
  title: 'Second Agent',
  driveId: 'drive-abc',
  isTrashed: false,
  createdAt: new Date('2025-06-01T00:00:00Z'),
};

const makeRequest = (authHeader = 'Bearer mcp_test123') =>
  new Request('http://localhost/api/v1/models', {
    method: 'GET',
    headers: { Authorization: authHeader },
  });

describe('GET /api/v1/models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mcpAuth);
    vi.mocked(getAllowedDriveIds).mockReturnValue([]);
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([agentPage1, agentPage2]),
      }),
    } as unknown as ReturnType<typeof db.select>);
  });

  test('returns 401 when auth fails', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    });
    const response = await GET(makeRequest());
    assert({
      given: 'a request with no valid MCP token',
      should: 'return 401 Unauthorized',
      actual: response.status,
      expected: 401,
    });
  });

  test('returns 200 with object:list envelope on happy path', async () => {
    const response = await GET(makeRequest());
    const body = await response.json() as { object: string; data: unknown[] };
    assert({
      given: 'a valid MCP token with accessible AI_CHAT pages',
      should: 'return 200 with an object:list envelope',
      actual: { status: response.status, object: body.object, hasData: Array.isArray(body.data) },
      expected: { status: 200, object: 'list', hasData: true },
    });
  });

  test('each model has the correct OpenAI shape', async () => {
    const response = await GET(makeRequest());
    const body = await response.json() as { object: string; data: Array<{ id: string; object: string; created: number; owned_by: string }> };
    const first = body.data[0];
    assert({
      given: 'accessible AI_CHAT pages',
      should: 'shape each as an OpenAI Model object',
      actual: {
        id: first.id,
        object: first.object,
        createdIsNumber: typeof first.created === 'number',
        owned_by: first.owned_by,
      },
      expected: {
        id: 'ps-agent://page-123',
        object: 'model',
        createdIsNumber: true,
        owned_by: 'pagespace',
      },
    });
  });

  test('model id uses ps-agent:// prefix', async () => {
    const response = await GET(makeRequest());
    const body = await response.json() as { data: Array<{ id: string }> };
    assert({
      given: 'an AI_CHAT page with id page-123',
      should: 'return model id ps-agent://page-123',
      actual: body.data[0].id,
      expected: 'ps-agent://page-123',
    });
  });

  test('excludes pages where canUserViewPage returns false', async () => {
    vi.mocked(canUserViewPage).mockImplementation(async (_userId, pageId) =>
      pageId === 'page-123'
    );
    const response = await GET(makeRequest());
    const body = await response.json() as { data: unknown[] };
    assert({
      given: 'canUserViewPage returning false for the second page',
      should: 'return only the accessible page',
      actual: body.data.length,
      expected: 1,
    });
  });

  test('returns empty list when no accessible AI_CHAT pages', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as unknown as ReturnType<typeof db.select>);
    const response = await GET(makeRequest());
    const body = await response.json() as { object: string; data: unknown[] };
    assert({
      given: 'no AI_CHAT pages in the accessible drives',
      should: 'return 200 with an empty data array',
      actual: { status: response.status, object: body.object, data: body.data },
      expected: { status: 200, object: 'list', data: [] },
    });
  });

  test('scoped token builds where clause with inArray for drive filtering', async () => {
    vi.mocked(getAllowedDriveIds).mockReturnValue(['drive-1', 'drive-2']);
    await GET(makeRequest());
    assert({
      given: 'a scoped MCP token with allowedDriveIds',
      should: 'call inArray to filter by drive IDs',
      actual: vi.mocked(inArray).mock.calls.length > 0,
      expected: true,
    });
  });

  test('unscoped token does not call inArray', async () => {
    vi.mocked(getAllowedDriveIds).mockReturnValue([]);
    await GET(makeRequest());
    assert({
      given: 'an unscoped MCP token with empty allowedDriveIds',
      should: 'not call inArray (no drive filter applied)',
      actual: vi.mocked(inArray).mock.calls.length,
      expected: 0,
    });
  });
});
