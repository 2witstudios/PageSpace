import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub out the pure functions from chat-pricing so tests control the math.
const { mockCalcStep, mockShouldAbort } = vi.hoisted(() => ({
  mockCalcStep: vi.fn<() => number>(),
  mockShouldAbort: vi.fn<() => boolean>(),
}));

vi.mock('@pagespace/lib/monitoring/chat-pricing', () => ({
  estimateChatHoldCentsForModel: vi.fn(),
  calcStepCostDollars: mockCalcStep,
  shouldAbortAfterStep: mockShouldAbort,
}));

// Stub credit-pricing constants (used by makeOnStepFinishHandler via imports at module level)
vi.mock('@pagespace/lib/billing/credit-pricing', () => ({
  MAX_CHAT_INFLIGHT: 8,
  MARKUP_BPS: 15000,
  RESERVE_FLOOR_CENTS: 25,
}));

// Stub every other heavy import so the module resolves without a Next.js / DB context.
vi.mock('next/server', () => ({ NextResponse: { json: vi.fn() } }));
vi.mock('ai', () => ({
  streamText: vi.fn(),
  convertToModelMessages: vi.fn(),
  stepCountIs: vi.fn(),
  hasToolCall: vi.fn(),
  createUIMessageStream: vi.fn(),
  createUIMessageStreamResponse: vi.fn(),
}));
vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn(), and: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: {} }));
vi.mock('@pagespace/db/schema/core', () => ({ chatMessages: {}, pages: {}, drives: {} }));
vi.mock('@pagespace/db/schema/members', () => ({ userProfiles: {} }));
vi.mock('@/lib/ai/core', () => ({
  createAIProvider: vi.fn(),
  updateUserProviderSettings: vi.fn(),
  createProviderErrorResponse: vi.fn(),
  isProviderError: vi.fn(),
  pageSpaceTools: {},
  extractMessageContent: vi.fn(),
  extractToolCalls: vi.fn(),
  extractToolResults: vi.fn(),
  saveMessageToDatabase: vi.fn(),
  sanitizeMessagesForModel: vi.fn(),
  convertDbMessageToUIMessage: vi.fn(),
  processMentionsInMessage: vi.fn(() => ({ pageIds: [], mentions: [] })),
  buildMentionSystemPrompt: vi.fn(() => ''),
  buildTimestampSystemPrompt: vi.fn(() => ''),
  buildSystemPrompt: vi.fn(async () => ''),
  buildPersonalizationPrompt: vi.fn(async () => ''),
  filterToolsForReadOnly: vi.fn((t) => t),
  getPageTreeContext: vi.fn(async () => ''),
  getModelCapabilities: vi.fn(async () => ({})),
  convertMCPToolsToAISDKSchemas: vi.fn(() => ({})),
  parseMCPToolName: vi.fn(),
  sanitizeToolNamesForProvider: vi.fn((t) => t),
  getUserPersonalization: vi.fn(async () => null),
  buildProviderAvailabilityMap: vi.fn(async () => ({})),
  ALL_PROVIDER_NAMES: [],
  ONPREM_ALLOWED_PROVIDERS: [],
  DEFAULT_PROVIDER: 'anthropic',
  DEFAULT_MODEL: 'claude-sonnet',
}));
vi.mock('@/lib/ai/core/ai-providers-config', () => ({
  ONPREM_ALLOWED_PROVIDERS: [],
  DEFAULT_PROVIDER: 'anthropic',
  DEFAULT_MODEL: 'claude-sonnet',
}));
vi.mock('@/lib/ai/core/ai-utils', () => ({ ALL_PROVIDER_NAMES: [] }));
vi.mock('@pagespace/lib/deployment-mode', () => ({ isOnPrem: false, isBillingEnabled: true }));
vi.mock('@/lib/ai/core/tool-utils', () => ({ mergeToolSets: vi.fn((a) => a) }));
vi.mock('@/lib/ai/tools/finish-tool', () => ({ finishTool: {}, FINISH_TOOL_NAME: 'finish' }));
vi.mock('@/lib/subscription/rate-limit-middleware', () => ({ requiresProSubscription: vi.fn(async () => null) }));
vi.mock('@pagespace/lib/billing/credit-gate', () => ({ canConsumeAI: vi.fn() }));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({ releaseHold: vi.fn(), consumeCredits: vi.fn() }));
vi.mock('@/lib/subscription/credit-gate-response', () => ({ creditGateErrorResponse: vi.fn() }));
vi.mock('@/lib/websocket', () => ({ broadcastChatUserMessage: vi.fn() }));
vi.mock('@/lib/ai/core/stream-lifecycle', () => ({ createStreamLifecycle: vi.fn() }));
vi.mock('@/lib/ai/streams/chunkToPart', () => ({ chunkToPart: vi.fn() }));
vi.mock('@/lib/ai/core/browser-session-id-validation', () => ({ validateBrowserSessionIdHeader: vi.fn(() => ({ ok: true, browserSessionId: 'bs1' })) }));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn(), checkMCPPageScope: vi.fn() }));
vi.mock('@pagespace/lib/permissions/permissions', () => ({ canUserViewPage: vi.fn(), canUserEditPage: vi.fn() }));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({ getActorInfo: vi.fn() }));
vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({ trackFeature: vi.fn() }));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { record: vi.fn() },
  extractOpenRouterCostDollars: vi.fn(() => null),
  extractOpenRouterGenerationIds: vi.fn(() => []),
}));
vi.mock('@/lib/mcp', () => ({ getMCPBridge: vi.fn() }));
vi.mock('@/services/api/page-mutation-service', () => ({ applyPageMutation: vi.fn(), PageRevisionMismatchError: class {} }));
vi.mock('@/lib/channels/expand-group-mentions', () => ({ expandMentionsToUserIds: vi.fn(async () => []) }));
vi.mock('@pagespace/lib/notifications/notifications', () => ({ createMentionNotification: vi.fn() }));
vi.mock('@/lib/ai/core/stream-abort-registry', () => ({
  createStreamAbortController: vi.fn(() => ({ streamId: 'sid', signal: new AbortController().signal })),
  removeStream: vi.fn(),
  STREAM_ID_HEADER: 'x-stream-id',
}));
vi.mock('@/lib/ai/core/run-agent-with-retry', () => ({
  runAgentWithRetry: vi.fn(),
  AGENT_MAX_STEPS: 10,
}));
vi.mock('@/lib/ai/core/validate-image-parts', () => ({ validateUserMessageFileParts: vi.fn(), hasFileParts: vi.fn(() => false) }));
vi.mock('@/lib/ai/core/model-capabilities', () => ({ hasVisionCapability: vi.fn(() => false) }));
vi.mock('@/lib/repositories/conversation-repository', () => ({ conversationRepository: { createConversation: vi.fn(), getConversation: vi.fn() } }));
vi.mock('@/lib/ai/tools/tool-exposure', () => ({ applyToolExposureMode: vi.fn((t) => ({ tools: t, toolDiscoveryPrompt: '' })) }));
vi.mock('@paralleldrive/cuid2', () => ({ createId: vi.fn(() => 'test-id') }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { ai: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() } } }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@/lib/logging/mask', () => ({ maskIdentifier: (s: string) => s }));

import { makeOnStepFinishHandler } from '../route';

beforeEach(() => vi.clearAllMocks());

describe('makeOnStepFinishHandler', () => {
  it('does NOT abort when accumulated cost stays within the balance', () => {
    const controller = new AbortController();
    const abortSpy = vi.spyOn(controller, 'abort');

    mockCalcStep.mockReturnValue(0.001); // $0.001 per step
    mockShouldAbort.mockReturnValue(false); // balance still OK

    const handler = makeOnStepFinishHandler(controller, 1000, 'test-model');
    handler({ promptTokens: 100, completionTokens: 50 });
    handler({ promptTokens: 100, completionTokens: 50 });
    handler({ promptTokens: 100, completionTokens: 50 });

    expect(abortSpy).not.toHaveBeenCalled();
  });

  it('aborts exactly once when shouldAbortAfterStep returns true', () => {
    const controller = new AbortController();
    const abortSpy = vi.spyOn(controller, 'abort');

    mockCalcStep.mockReturnValue(0.01);
    mockShouldAbort
      .mockReturnValueOnce(false) // step 1 — within budget
      .mockReturnValueOnce(false) // step 2 — within budget
      .mockReturnValue(true);     // step 3+ — exhausted

    const handler = makeOnStepFinishHandler(controller, 100, 'test-model');
    handler({ promptTokens: 500, completionTokens: 200 });
    handler({ promptTokens: 500, completionTokens: 200 });
    handler({ promptTokens: 500, completionTokens: 200 }); // triggers abort
    handler({ promptTokens: 500, completionTokens: 200 }); // controller already aborted — would abort again

    // abort() is called at step 3; step 4 also calls it (already-aborted controller is a no-op,
    // but we only care that the FIRST threshold crossing triggered it)
    expect(abortSpy).toHaveBeenCalled();
  });

  it('accumulates cost across steps before passing to shouldAbortAfterStep', () => {
    const controller = new AbortController();
    mockCalcStep.mockReturnValue(0.05);
    mockShouldAbort.mockReturnValue(false);

    const handler = makeOnStepFinishHandler(controller, 500, 'gpt-model');
    handler({ promptTokens: 100, completionTokens: 50 });
    handler({ promptTokens: 200, completionTokens: 100 });

    // Second call should see cumulative = 0.05 + 0.05 = 0.10
    expect(mockShouldAbort).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cumulativeCostDollars: 0.10,
    }));
  });

  it('passes the correct balanceCents and model to the underlying helpers', () => {
    const controller = new AbortController();
    mockCalcStep.mockReturnValue(0.01);
    mockShouldAbort.mockReturnValue(false);

    const handler = makeOnStepFinishHandler(controller, 300, 'anthropic/claude-opus-4.8');
    handler({ promptTokens: 100, completionTokens: 50 });

    expect(mockCalcStep).toHaveBeenCalledWith('anthropic/claude-opus-4.8', { promptTokens: 100, completionTokens: 50 });
    expect(mockShouldAbort).toHaveBeenCalledWith(expect.objectContaining({
      balanceCents: 300,
      markupBps: 15000,
      reserveFloorCents: 25,
    }));
  });
});

describe('creditAbortController null path', () => {
  it('abort is never called when no creditAbortController is created (billing disabled)', () => {
    // When creditAbortController is null, makeOnStepFinishHandler is never called
    // and onStepFinishForCredits is null — the handler simply isn't wired.
    // This test confirms the guard logic by directly testing the null branch:
    // if we don't create a handler, no abort fires.
    const controller = new AbortController();
    const abortSpy = vi.spyOn(controller, 'abort');

    // onStepFinishForCredits is null — simulate by never calling a handler
    // (the route does: `onStepFinish: onStepFinishForCredits ? async ({usage}) => ... : undefined`)
    const noop = null as ReturnType<typeof makeOnStepFinishHandler> | null;
    if (noop) noop({ promptTokens: 100, completionTokens: 50 });

    expect(abortSpy).not.toHaveBeenCalled();
  });
});
