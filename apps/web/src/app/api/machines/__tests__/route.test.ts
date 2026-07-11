/**
 * Contract tests for GET /api/machines — the Development surface's
 * list-machines-in-a-drive query.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAuthenticateRequest, mockIsAuthError, mockListDriveMachines } = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockIsAuthError: vi.fn((result: unknown) => result != null && typeof result === 'object' && 'error' in result),
  mockListDriveMachines: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => mockIsAuthError(result),
}));

vi.mock('@/lib/machines/machine-list-runtime', () => ({
  listDriveMachines: (...args: unknown[]) => mockListDriveMachines(...args),
}));

import { GET } from '../route';

const AUTH_OK = { userId: 'user-1' };
const AUTH_DENIED = { error: new Response(null, { status: 401 }) };

const MACHINE = { id: 'machine-1', title: 'Dev box', updatedAt: '2026-07-11T00:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_OK);
  mockListDriveMachines.mockResolvedValue([MACHINE]);
});

describe('GET /api/machines', () => {
  it('returns the drive\'s machines for the authenticated user', async () => {
    const response = await GET(new Request('http://localhost/api/machines?driveId=drive-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ machines: [MACHINE] });
    expect(mockListDriveMachines).toHaveBeenCalledWith('user-1', 'drive-1');
  });

  it('400s without a driveId', async () => {
    const response = await GET(new Request('http://localhost/api/machines'));

    expect(response.status).toBe(400);
    expect(mockListDriveMachines).not.toHaveBeenCalled();
  });

  it('propagates the auth error and never touches the drive', async () => {
    mockAuthenticateRequest.mockResolvedValue(AUTH_DENIED);

    const response = await GET(new Request('http://localhost/api/machines?driveId=drive-1'));

    expect(response.status).toBe(401);
    expect(mockListDriveMachines).not.toHaveBeenCalled();
  });

  it('serves an empty list rather than 404 when the drive has no machines', async () => {
    mockListDriveMachines.mockResolvedValue([]);

    const response = await GET(new Request('http://localhost/api/machines?driveId=drive-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ machines: [] });
  });
});
