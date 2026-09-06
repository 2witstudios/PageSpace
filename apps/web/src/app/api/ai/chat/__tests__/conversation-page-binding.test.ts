/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

// ============================================================================
// "DOES THIS CONVERSATION BELONG TO THIS PAGE?" — the page-agent write gate in
// `runPageChatTurn` (apps/web/src/lib/ai/chat-pipeline/page-chat-turn.ts).
//
// The gate used to answer that question from `contextId` ALONE:
//
//     const belongsToThisPage =
//       !existingConversation.contextId || existingConversation.contextId === chatId;
//
// A `type='global'` conversation ALWAYS has `contextId IS NULL` — that is a
// database CHECK (`conversations_global_context_null_chk`, migration 0250) —
// so the first disjunct made every global conversation "belong to" every page.
// `POST /api/ai/chat` with your own global `conversationId` plus any `chatId`
// you can edit therefore wrote a page-agent turn (your prompt AND the model's
// reply, authored by that page's agent, with that page's tools) straight into
// the global-assistant transcript. Flagged twice and closed by neither: CodeQL
// `js/user-controlled-bypass` (high, open on master since 2026-08-04, citing
// the pre-consolidation line `apps/web/src/app/api/ai/chat/route.ts:970`) and
// an adversarial security review, finding 10.
//
// The answer is now the SAME predicate every page-scoped reader already uses —
// `unifiedPageScope()` (apps/web/src/lib/repositories/unified-message-scope.ts):
// a row belongs to page X when it is `type='page'` with `contextId = X`, or
// `type='client'` with `agentPageId = X`. Nothing else does, so 'global' and
// 'drive' are refused outright.
//
// The one deliberate widening beyond `unifiedPageScope` is the legacy
// tolerance the old disjunct was really there for, now scoped two ways: a
// `type='page'` row with a NULL `contextId` (legal only because
// `conversations_page_context_present_chk` shipped NOT VALID, so pre-existing
// rows were grandfathered) is accepted only FOR ITS OWNER. That is exactly the
// stated intent of the original comment — "an owner must never be locked out
// of their own row by a historically-unset column" — and it also closes the
// residual the review named: a legacy null-context row with `isShared=true`
// was writable from every page any co-member could edit.
//
// The mock preamble below is shared with credit-gate.test.ts and
// conversation-create-fail-closed.test.ts — same route, same heavy graph.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: any) => 'error' in result),
  isMCPAuthResult: vi.fn((r: any) => r?.tokenType === 'mcp'),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  getAllowedDriveIds: vi.fn(() => []),
  isScopedMCPAuth: vi.fn(() => false),
  // Same boolean as isScopedMCPAuth for these fixtures; the real helper reads
  // through getAllowedDriveIds so it also covers dispatched service auth.
  //
  // Typed from the REAL exports, so a signature change here fails typecheck
  // rather than leaving a silently stale stub. The bodies reimplement rather
  // than delegate to the sibling `getAllowedDriveIds` mock: that mock is a
  // fixed `() => []` in these fixtures, so delegating would make every
  // credential read as unscoped and the scope assertions vacuous.
  isDriveScopedPrincipal: vi.fn<typeof import('@/lib/auth').isDriveScopedPrincipal>(
    (auth) => (('allowedDriveIds' in auth ? auth.allowedDriveIds : []) ?? []).length > 0,
  ),
  isServiceAuthResult: vi.fn<typeof import('@/lib/auth').isServiceAuthResult>(
    (result): result is import('@/lib/auth').ServiceAuthResult =>
      !('error' in result) && 'tokenType' in result && result.tokenType === 'service',
  ),
  canPrincipalViewPage: vi.fn(async (auth: { userId: string }, pageId: string) => {
    const { canUserViewPage } = await import('@pagespace/lib/permissions/permissions');
    return canUserViewPage(auth.userId, pageId);
  }),
  canPrincipalEditPage: vi.fn(async (auth: { userId: string }, pageId: string) => {
    const { canUserEditPage } = await import('@pagespace/lib/permissions/permissions');
    return canUserEditPage(auth.userId, pageId);
  }),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn().mockResolvedValue(true),
  canUserEditPage: vi.fn().mockResolvedValue(true),
}));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@test.com', actorDisplayName: 'Test' }),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: {
      info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn(),
      child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() })),
    },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

// Chainable, thenable query builder: every method returns the builder, and the
// builder itself resolves (awaits) to a single-row result. This satisfies both
// `db.select().from().where()` and `db.select().from().where().limit(1)` shapes.
vi.mock('@pagespace/db/db', () => {
  const row = {
    id: 'page_123',
    title: 'Test Page',
    systemPrompt: null,
    enabledTools: null,
    aiProvider: 'openai',
    aiModel: 'openai/gpt-5.4-nano',
    driveId: 'drive_A',
    includeDrivePrompt: false,
    includePageTree: false,
    pageTreeScope: null,
    revision: 0,
    subscriptionTier: 'free',
    displayName: 'Tester',
  };
  const makeBuilder = () => {
    const builder: any = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      then: (resolve: (v: unknown[]) => unknown) => resolve([row]),
      catch: () => builder,
    };
    return builder;
  };
  return {
    db: {
      select: vi.fn(() => makeBuilder()),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
      insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    },
  };
});
// exists/sql: globalConversationRepository's module-scope `hasMessages` query
// (now reachable transitively via stream-takeover -> materialize-interrupted-stream
// -> global-conversation-repository, #2153) needs both or the module throws on import.
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn(), and: vi.fn(), exists: vi.fn(), sql: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id' } }));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id' },
  drives: { id: 'id', drivePrompt: 'drivePrompt' },
}));

vi.mock('@/lib/subscription/rate-limit-middleware', () => ({
  requiresProSubscription: vi.fn().mockReturnValue(false),
  createSubscriptionRequiredResponse: vi.fn(),
  createAdminRestrictedResponse: vi.fn(),
}));

// The credit gate under test. Default: allowed. Individual tests override.
vi.mock('@pagespace/lib/billing/credit-gate', () => ({
  canConsumeAI: vi.fn().mockResolvedValue({ allowed: true, reason: 'unlimited' }),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastCreditsEvent: vi.fn(),
  broadcastChatUserMessage: vi.fn(),
}));

vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: vi.fn().mockResolvedValue({ model: {} }),
  updateUserProviderSettings: vi.fn(),
  createProviderErrorResponse: vi.fn(),
  isProviderError: vi.fn().mockReturnValue(false),
}));
vi.mock('@/lib/ai/core/message-utils', () => ({
  extractMessageContent: vi.fn().mockReturnValue('test content'),
  extractToolCalls: vi.fn().mockReturnValue([]),
  extractToolResults: vi.fn().mockReturnValue([]),
  saveMessageToDatabase: vi.fn(),
  sanitizeMessagesForModel: vi.fn().mockReturnValue([]),
  convertDbMessageToUIMessage: vi.fn(),
}));
vi.mock('@/lib/ai/core/mention-processor', () => ({
  processMentionsInMessage: vi.fn().mockReturnValue({ mentions: [], pageIds: [] }),
}));
vi.mock('@/lib/ai/core/timestamp-utils', () => ({
  buildTimestampSystemPrompt: vi.fn().mockReturnValue(''),
}));
vi.mock('@/lib/ai/core/system-prompt', () => ({
  buildSystemPrompt: vi.fn().mockReturnValue(''),
  buildPersonalizationPrompt: vi.fn().mockReturnValue(''),
}));
vi.mock('@/lib/ai/core/tool-filtering', () => ({
  filterToolsForSandboxTier: vi.fn((tools: unknown) => tools),
  filterToolsForEphemeralWorkspace: vi.fn((tools: unknown) => tools),
  filterToolsForSandboxEnablement: vi.fn((tools: unknown) => tools),
  filterToolsForAgentAllowlist: vi.fn((tools: unknown) => tools),
  filterToolsForReadOnly: vi.fn().mockReturnValue({}),
  filterToolsForWebSearch: vi.fn().mockReturnValue({}),
  filterToolsForMcpScope: vi.fn().mockReturnValue({}),
  buildPageAITools: vi.fn().mockReturnValue({}),
}));
vi.mock('@/lib/ai/core/page-tree-context', () => ({
  getPageTreeContext: vi.fn(),
}));
vi.mock('@/lib/ai/core/ai-tools', () => ({ pageSpaceTools: {}, corePageSpaceTools: {} }));
vi.mock('@/lib/ai/core/mcp-tool-converter', () => ({
  convertMCPToolsToAISDKSchemas: vi.fn(),
  parseMCPToolName: vi.fn(),
  sanitizeToolNamesForProvider: vi.fn(),
}));
vi.mock('@/lib/ai/core/personalization-utils', () => ({
  getUserPersonalization: vi.fn().mockResolvedValue(null),
}));
vi.mock('ai', () => ({
  streamText: vi.fn(),
  convertToModelMessages: vi.fn().mockReturnValue([]),
  stepCountIs: vi.fn(),
  hasToolCall: vi.fn(() => () => false),
  tool: vi.fn((config) => config),
  createUIMessageStream: vi.fn(),
  createUIMessageStreamResponse: vi.fn(),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('generated_id'),
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
}));

vi.mock('@/lib/logging/mask', () => ({ maskIdentifier: vi.fn((id: string) => `***${id.slice(-3)}`) }));
vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({ trackFeature: vi.fn() }));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: vi.fn(), trackToolUsage: vi.fn() },
  extractOpenRouterCostDollars: vi.fn(() => undefined),
  extractOpenRouterGenerationIds: vi.fn(() => []),
}));
vi.mock('@/lib/mcp', () => ({ getMCPBridge: vi.fn() }));
vi.mock('@/services/api/page-mutation-service', () => ({
  applyPageMutation: vi.fn(),
  PageRevisionMismatchError: class extends Error {},
}));
vi.mock('@/lib/ai/core/stream-abort-registry', () => ({
  createStreamAbortController: vi.fn().mockReturnValue({ streamId: 'stream_123', signal: new AbortController().signal }),
  removeStream: vi.fn(),
  STREAM_ID_HEADER: 'x-stream-id',
}));
vi.mock('@/lib/ai/core/validate-image-parts', () => ({
  validateUserMessageFileParts: vi.fn().mockReturnValue({ valid: true }),
  hasFileParts: vi.fn().mockReturnValue(false),
}));
vi.mock('@/lib/ai/core/model-capabilities', () => ({
  getModelCapabilities: vi.fn().mockResolvedValue({}),
  hasVisionCapability: vi.fn().mockReturnValue(true),
}));



// The subject: the gate reads the row through `getConversation`, and — when it
// lets the request past — the very next conversation call is the eager
// `createConversation`. So "was createConversation reached" is a precise,
// side-effect-free probe for "the gate allowed this write", with no need to
// drive the heavily-mocked request all the way to a streamed response.
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: {
    getConversation: vi.fn().mockResolvedValue(null),
    hasConflictingMessageOwner: vi.fn().mockResolvedValue(false),
    createConversation: vi.fn().mockResolvedValue('exists'),
    autoTitleConversation: vi.fn().mockResolvedValue(undefined),
    getConversationById: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({
  releaseHold: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { streamText } from 'ai';

const ATTACKER = 'user_123';
const VICTIM = 'user_victim';
/** The page the caller can edit — `canUserEditPage` is mocked true throughout. */
const THIS_PAGE = 'page_123';
const OTHER_PAGE = 'page_other';
const DRIVE = 'drive_A';
const CONVERSATION = 'conv_target';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

/** A `conversations` row, defaulted to the benign shape each test perturbs. */
const conversationRow = (overrides: Record<string, unknown>) => ({
  id: CONVERSATION,
  userId: ATTACKER,
  title: null,
  type: 'page',
  contextId: THIS_PAGE,
  agentPageId: null,
  rev: 0,
  lastMessageAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  isActive: true,
  isShared: false,
  ...overrides,
});

const post = (conversationId: string, chatId: string = THIS_PAGE) =>
  new Request('https://example.com/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '200', 'X-Browser-Session-Id': 'session-1' },
    body: JSON.stringify({
      messages: [{ id: 'msg_1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
      chatId,
      conversationId,
      selectedProvider: 'openai',
      selectedModel: 'openai/gpt-5.4-nano',
    }),
  });

describe('POST /api/ai/chat - a conversation must belong to the page it is sent to', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(ATTACKER));
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: true, reason: 'unlimited', holdId: 'hold_1' } as never);
    vi.mocked(conversationRepository.createConversation).mockResolvedValue('exists');
  });

  describe('type=global (the reported defect)', () => {
    it('refuses the caller\'s OWN global conversation addressed at a page they can edit', async () => {
      // The exact reported request: your own global thread, any chatId you can
      // edit. `contextId` is null because the CHECK constraint requires it to
      // be — which is precisely why `!contextId` could never be the test.
      vi.mocked(conversationRepository.getConversation).mockResolvedValue(
        conversationRow({ type: 'global', contextId: null }) as never,
      );

      const response = await POST(post(CONVERSATION));

      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe('Forbidden');
    });

    it('writes nothing and invokes no model when it refuses a global conversation', async () => {
      vi.mocked(conversationRepository.getConversation).mockResolvedValue(
        conversationRow({ type: 'global', contextId: null }) as never,
      );

      await POST(post(CONVERSATION));

      expect(conversationRepository.createConversation).not.toHaveBeenCalled();
      expect(streamText).not.toHaveBeenCalled();
    });

    it('refuses a SHARED global conversation belonging to another user', async () => {
      // The escalation the review judged unreachable (no writer can set
      // `isShared` on a global row). Pinned anyway: the gate must not be the
      // thing that made it unreachable.
      vi.mocked(conversationRepository.getConversation).mockResolvedValue(
        conversationRow({ userId: VICTIM, type: 'global', contextId: null, isShared: true }) as never,
      );

      const response = await POST(post(CONVERSATION));

      expect(response.status).toBe(403);
    });
  });

  describe('type=drive', () => {
    it('refuses a drive conversation even when its contextId happens to equal the chatId', async () => {
      // `type='drive'` has no page at all (`derivedPageId()` yields NULL for
      // it), so a drive row is refused on its type — not on whether its
      // drive id coincidentally collides with a page id.
      vi.mocked(conversationRepository.getConversation).mockResolvedValue(
        conversationRow({ type: 'drive', contextId: THIS_PAGE }) as never,
      );

      const response = await POST(post(CONVERSATION));

      expect(response.status).toBe(403);
    });
  });

  describe('type=page (the ordinary in-app page chat)', () => {
    it('allows the owner\'s own page conversation whose contextId is this page', async () => {
      vi.mocked(conversationRepository.getConversation).mockResolvedValue(
        conversationRow({ type: 'page', contextId: THIS_PAGE }) as never,
      );

      await POST(post(CONVERSATION));

      expect(conversationRepository.createConversation).toHaveBeenCalled();
    });

    it('refuses a page conversation anchored to a DIFFERENT page', async () => {
      vi.mocked(conversationRepository.getConversation).mockResolvedValue(
        conversationRow({ type: 'page', contextId: OTHER_PAGE }) as never,
      );

      const response = await POST(post(CONVERSATION));

      expect(response.status).toBe(403);
    });

    it('allows a shared page conversation of another user on THIS page', async () => {
      // Unchanged sharing semantics: `isShared` plus edit access to the page
      // the thread is anchored to is what deliberate sharing means.
      vi.mocked(conversationRepository.getConversation).mockResolvedValue(
        conversationRow({ userId: VICTIM, type: 'page', contextId: THIS_PAGE, isShared: true }) as never,
      );

      await POST(post(CONVERSATION));

      expect(conversationRepository.createConversation).toHaveBeenCalled();
    });
  });

  describe('legacy type=page rows with a NULL contextId', () => {
    it('still lets the OWNER write to their own historically-unset row', async () => {
      // `conversations_page_context_present_chk` shipped NOT VALID, so these
      // rows exist. The tolerance the old disjunct was really for, kept.
      vi.mocked(conversationRepository.getConversation).mockResolvedValue(
        conversationRow({ type: 'page', contextId: null }) as never,
      );

      await POST(post(CONVERSATION));

      expect(conversationRepository.createConversation).toHaveBeenCalled();
    });

    it('refuses a NON-owner writing into a shared legacy row from an arbitrary page', async () => {
      // The residual the review identified: a shared legacy row used to be
      // writable from EVERY page the caller could edit, because a null
      // contextId matched them all. Scoping the tolerance to the owner is
      // what closes it.
      vi.mocked(conversationRepository.getConversation).mockResolvedValue(
        conversationRow({ userId: VICTIM, type: 'page', contextId: null, isShared: true }) as never,
      );

      const response = await POST(post(CONVERSATION, OTHER_PAGE));

      expect(response.status).toBe(403);
    });
  });

  describe('type=client (API-managed threads: a DRIVE in contextId, the page in agentPageId)', () => {
    it('allows a client thread whose agentPageId is this page', async () => {
      // `unifiedPageScope`'s second disjunct. Its `contextId` is the DRIVE the
      // MCP token is authorized against and is meaningless as a page match, so
      // reading it as one is exactly the confusion this fix removes.
      vi.mocked(conversationRepository.getConversation).mockResolvedValue(
        conversationRow({ type: 'client', contextId: DRIVE, agentPageId: THIS_PAGE }) as never,
      );

      await POST(post(CONVERSATION));

      expect(conversationRepository.createConversation).toHaveBeenCalled();
    });

    it('refuses a client thread anchored to a different agent page', async () => {
      vi.mocked(conversationRepository.getConversation).mockResolvedValue(
        conversationRow({ type: 'client', contextId: DRIVE, agentPageId: OTHER_PAGE }) as never,
      );

      const response = await POST(post(CONVERSATION));

      expect(response.status).toBe(403);
    });

    it('refuses an unstamped client thread (agentPageId still NULL) rather than matching every page', async () => {
      // The same defect as the global one, in a second shape: a client thread
      // minted with no drive scope has BOTH columns null until its first
      // completion stamps the page, so `!contextId` matched every page here
      // too. There is no owner tolerance for this type — the stamp is the
      // page, and an unstamped thread has none.
      vi.mocked(conversationRepository.getConversation).mockResolvedValue(
        conversationRow({ type: 'client', contextId: null, agentPageId: null }) as never,
      );

      const response = await POST(post(CONVERSATION));

      expect(response.status).toBe(403);
    });
  });

  describe('checks that must keep running ahead of the page match', () => {
    it('still refuses a non-owner\'s private conversation on this very page', async () => {
      vi.mocked(conversationRepository.getConversation).mockResolvedValue(
        conversationRow({ userId: VICTIM, type: 'page', contextId: THIS_PAGE, isShared: false }) as never,
      );

      const response = await POST(post(CONVERSATION));

      expect(response.status).toBe(403);
    });

    it('still 404s a history-deleted row before the page match is even considered', async () => {
      vi.mocked(conversationRepository.getConversation).mockResolvedValue(
        conversationRow({ type: 'page', contextId: THIS_PAGE, isActive: false }) as never,
      );

      const response = await POST(post(CONVERSATION));

      expect(response.status).toBe(404);
    });
  });
});
