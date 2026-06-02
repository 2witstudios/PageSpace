/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Prepaid credit-gate enforcement for POST /api/pulse/generate
//
// This is the on-demand (user-triggered) Pulse path, so it is gated: an
// out-of-credits user gets a 402 before any context gathering or model call.
// (The cron path is intentionally NOT gated and is not exercised here.)
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: any) => r != null && typeof r === 'object' && 'error' in r),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() } },
}));

const pulseUser = { id: 'user-1', name: 'Tester', email: 'tester@example.com', timezone: 'UTC', subscriptionTier: 'pro' };

vi.mock('@pagespace/db/db', () => {
  const builder: any = {
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    then: (resolve: (v: unknown[]) => unknown) => resolve([pulseUser]),
  };
  return { db: { select: vi.fn(() => builder), update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })) } };
});
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(), and: vi.fn(), or: vi.fn(), lt: vi.fn(), gte: vi.fn(), ne: vi.fn(),
  desc: vi.fn(), inArray: vi.fn(), isNotNull: vi.fn(), isNull: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', subscriptionTier: 'subscriptionTier' } }));

// The credit gate under test. Default: allowed. Individual tests override.
vi.mock('@pagespace/lib/billing/credit-gate', () => ({
  canConsumeAI: vi.fn().mockResolvedValue({ allowed: true, reason: 'unlimited' }),
}));

vi.mock('@/lib/ai/core', () => ({
  createAIProvider: vi.fn().mockResolvedValue({ model: {}, provider: 'pagespace', modelName: 'glm-4.5-air' }),
  isProviderError: vi.fn().mockReturnValue(false),
  buildTimestampSystemPrompt: vi.fn().mockReturnValue(''),
  getUserTimeOfDay: vi.fn().mockReturnValue('morning'),
  getStartOfTodayInTimezone: vi.fn().mockReturnValue(new Date(0)),
  isValidTimezone: vi.fn().mockReturnValue(true),
  normalizeTimezone: vi.fn((tz?: string) => tz ?? 'UTC'),
  formatDateInTimezone: vi.fn().mockReturnValue('today'),
}));

vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({ text: 'pulse', steps: [], totalUsage: { totalTokens: 0 } }),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { createAIProvider } from '@/lib/ai/core';
import { generateText } from 'ai';

const mockAuth = () => ({
  userId: 'user-1',
  tokenVersion: 0,
  tokenType: 'session' as const,
  sessionId: 'sess-1',
  role: 'user' as const,
  adminRoleVersion: 0,
});

const makeRequest = () =>
  new Request('https://example.com/api/pulse/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ timezone: 'UTC' }),
  });

describe('POST /api/pulse/generate — prepaid credit gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: true, reason: 'unlimited' });
  });

  it('returns 402 out_of_credits before any context gathering or model call', async () => {
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: false, reason: 'out_of_credits' });

    const response = await POST(makeRequest());

    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.error).toBe('out_of_credits');
    expect(createAIProvider).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  it("consults the gate with the user's resolved subscription tier", async () => {
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: false, reason: 'out_of_credits' });

    await POST(makeRequest());

    expect(canConsumeAI).toHaveBeenCalledWith('user-1', 'pro');
  });
});
