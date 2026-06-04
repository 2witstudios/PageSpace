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

// Sentinel for the user_automation_preferences table + the row the toggle lookup
// returns, shared with the hoisted db mock factory via vi.hoisted. Default rows = []
// (no preference row ⇒ Pulse enabled); the disabled test sets pulseEnabled: false.
const h = vi.hoisted(() => ({
  automationSentinel: { userId: 'userId', pulseEnabled: 'pulseEnabled' } as Record<string, string>,
  automationRows: [] as unknown[],
}));

vi.mock('@pagespace/db/db', () => {
  // Fresh, table-aware builder per select(): the automation-prefs query resolves to
  // `h.automationRows`; every other query resolves to [pulseUser].
  const makeBuilder = () => {
    let table: unknown;
    const b: any = {
      from: vi.fn((t: unknown) => { table = t; return b; }),
      where: vi.fn(() => b),
      then: (resolve: (v: unknown[]) => unknown) =>
        resolve(table === h.automationSentinel ? h.automationRows : [pulseUser]),
    };
    return b;
  };
  return { db: { select: vi.fn(() => makeBuilder()), update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })) } };
});
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(), and: vi.fn(), or: vi.fn(), lt: vi.fn(), gte: vi.fn(), ne: vi.fn(),
  desc: vi.fn(), inArray: vi.fn(), isNotNull: vi.fn(), isNull: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', subscriptionTier: 'subscriptionTier' } }));
vi.mock('@pagespace/db/schema/automation-preferences', () => ({ userAutomationPreferences: h.automationSentinel }));

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
import { MAX_CHAT_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
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
    h.automationRows = []; // default: no preference row ⇒ Pulse enabled
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: true, reason: 'unlimited' });
  });

  it('no-ops (no gate, no model call) when the user disabled Pulse', async () => {
    h.automationRows = [{ pulseEnabled: false }];

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ skipped: true, reason: 'pulse_disabled' });
    // The opt-out must short-circuit BEFORE the credit gate and any model invocation,
    // so a disabled user can never spend credits on Pulse.
    expect(canConsumeAI).not.toHaveBeenCalled();
    expect(createAIProvider).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
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

  it("consults the gate with the user's resolved subscription tier and the chat concurrency cap", async () => {
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: false, reason: 'out_of_credits' });

    await POST(makeRequest());

    // The model isn't resolved at the gate, so Pulse passes no per-call estimate (the
    // hold uses the default) but does apply the chat in-flight cap to bound concurrent
    // overdraw.
    expect(canConsumeAI).toHaveBeenCalledWith('user-1', 'pro', { maxInFlight: MAX_CHAT_INFLIGHT });
  });
});
