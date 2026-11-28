/**
 * Agent Signup Phase 2c: the accept notification's text is written once and
 * rendered without a lookup, so an agent accepter is marked at write time
 * ("Name (AI agent)"); a human accepter's text is unchanged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockConnectionLimit, mockActorLimit } = vi.hoisted(() => ({
  mockConnectionLimit: vi.fn(),
  mockActorLimit: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: mockConnectionLimit })),
        leftJoin: vi.fn(() => ({ where: vi.fn(() => ({ limit: mockActorLimit })) })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'conn-1' }]) })) })),
    })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn(), and: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: {} }));
vi.mock('@pagespace/db/schema/members', () => ({ userProfiles: {} }));
vi.mock('@pagespace/db/schema/social', () => ({
  connections: { id: 'id', user1Id: 'user1Id', user2Id: 'user2Id', status: 'status' },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/encryption/field-crypto', () => ({
  decryptField: vi.fn(async (value: string | null | undefined) => value ?? null),
}));
vi.mock('@pagespace/lib/notifications/notifications', () => ({
  createNotification: vi.fn(),
  markConnectionRequestActioned: vi.fn(),
}));

import { PATCH } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { createNotification } from '@pagespace/lib/notifications/notifications';

const accept = () =>
  PATCH(
    new Request('http://localhost/api/connections/conn-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept' }),
    }),
    { params: Promise.resolve({ connectionId: 'conn-1' }) },
  );

describe('PATCH /api/connections/[connectionId] accept — agent accepter is marked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      userId: 'user_123',
      tokenVersion: 0,
      tokenType: 'session' as const,
      sessionId: 'test-session',
      role: 'user' as const,
      adminRoleVersion: 0,
    });
    mockConnectionLimit.mockResolvedValue([
      { id: 'conn-1', user1Id: 'user_123', user2Id: 'user_456', status: 'PENDING', requestedBy: 'user_456' },
    ]);
  });

  it('given an agent account accepting, writes "Name (AI agent)" into the message and metadata', async () => {
    mockActorLimit.mockResolvedValue([{ name: 'PageSpace Support', displayName: null, accountType: 'agent' }]);

    await accept();

    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
      message: 'PageSpace Support (AI agent) accepted your connection request',
      metadata: expect.objectContaining({ accepterName: 'PageSpace Support (AI agent)' }),
    }));
  });

  it('given a human accepting, the text is unchanged', async () => {
    mockActorLimit.mockResolvedValue([{ name: 'Alice', displayName: null, accountType: 'human' }]);

    await accept();

    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Alice accepted your connection request',
      metadata: expect.objectContaining({ accepterName: 'Alice' }),
    }));
  });
});
