/**
 * THE CHAT PIPELINE ENTRY — one handler, two URL surfaces, and the end of the
 * `agentPageId === null` dispatch branch.
 *
 * Epic "Agent-Session Single Source of Truth", Phase 5 (chat route
 * consolidation). Two POST routes exist for historical reasons:
 *
 *   `POST /api/ai/chat`                     — page-agent turns
 *   `POST /api/ai/global/[id]/messages`     — global-assistant turns
 *
 * They were separate because there were TWO MESSAGE TABLES and the two shapes
 * could not meet. That reason is gone (Phase 4: one `messages` table, one
 * `message-repository`, one reader set), so the *implementation* collapses
 * here: both URLs now call this function, which picks the strategy from the
 * CONVERSATION rather than from the URL, and `dispatchThroughChatPipeline`
 * targets exactly one internal path regardless of `agentPageId`.
 *
 * Both public URLs keep their exact wire contract — auth, body, statuses,
 * headers, stream — because retiring a URL is a separate decision with its own
 * compat window (deployed browsers, desktop, mobile, MCP, the CLI, and any
 * running agent all still address them by name).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ACTUALLY SHARED, AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 *
 * Shared here, once, for every turn on either surface:
 *
 *   1. `X-Browser-Session-Id` validation (byte-identical in both routes)
 *   2. authentication — the SURFACE's own options, unchanged (see below)
 *   3. the 25MB `content-length` guard (byte-identical)
 *   4. the JSON body parse
 *   5. the strategy decision itself
 *
 * Everything after that genuinely differs, and differs in ways that are load
 * bearing — so it stays behind an explicit strategy rather than behind two
 * dozen `if (kind === 'page')` branches inside one 4,000-line function. The
 * divergences, all verified against both routes rather than assumed:
 *
 *  | Concern                | page-agent turn                              | global-assistant turn                       |
 *  |------------------------|----------------------------------------------|---------------------------------------------|
 *  | auth types             | `session` + `mcp`                            | `session` only                              |
 *  | authorization subject  | the AGENT PAGE (`canPrincipalView/EditPage`) | the CONVERSATION (owner-only)               |
 *  | MCP scoping            | `checkMCPPageScope`, `getAllowedDriveIds`,   | n/a — MCP cannot reach this strategy        |
 *  |                        | `isScopedMCPAuth`, tool-set drive ceiling    |                                             |
 *  | conversation minting   | caller-supplied id, cuid/legacy-owner/shared | `resolveOrCreateConversation` (lazy create, |
 *  |                        | /page-match rules, eager `createConversation`| owner + `type='global'` + isActive)         |
 *  | tool set               | per-agent `enabledTools` allowlist, sandbox  | always search-mode (`tool_search` +         |
 *  |                        | enablement + tier, dispatch credentials,     | `execute_tool`), no per-agent allowlist,    |
 *  |                        | `page.toolExposureMode`                      | drive-role-scoped integrations              |
 *  | system prompt          | agent's own `systemPrompt`/drive prompt/     | Global-Assistant preamble, agent awareness, |
 *  |                        | member-drive context/agent memory/page tree  | location drive prompt, drive list summary   |
 *  | credit gate            | + mid-stream credit abort (`step-finish`)    | gate only                                   |
 *  | provider admission     | `resolveGenerationAdmission` BEFORE the      | `ADMIN_ONLY_PROVIDERS`/`requiresPro` AFTER  |
 *  |                        | factory, on the requested pair               | the factory, on the resolved pair           |
 *  | provider persistence   | also writes `page.aiProvider/aiModel`        | user settings only                          |
 *  | history read           | page-scoped seam (`getPageConversationMessages`) | conversation seam (`getMessagesByConversationId`) |
 *  | prompt assembly extras | —                                            | visual-content injection, context-size calc |
 *  | @mentions              | notifies mentioned users, exactly-once latch | no notification surface                     |
 *  | realtime               | page-room `chat:user_message` gated on       | global channel, ungated, plus               |
 *  |                        | `isShared`                                   | `conversation:added` for a new row          |
 *  | usage telemetry        | pageId/driveId/pageName, per-tool tracking,  | context-window fields; no error-path row    |
 *  |                        | error-path `success:false` row               |                                             |
 *  | `/help` short-circuit  | same code path, different broadcast gate + drive source                                     |
 *  | dispatch depth         | identical (`X-Agent-Dispatch-Depth`)                                                        |
 *  | response headers       | identical (`STREAM_ID_HEADER` on the stream)                                                |
 *
 * Collapsing that table into one function would mean ~20 conditionals in the
 * app's highest-risk code path, several of them security decisions (which
 * principal, which page, which drive scope, which tools). The consolidation
 * that pays for itself is the one below: ONE entry, ONE decision, and the
 * concurrency-critical generation start shared outright
 * (`start-chat-generation.ts`) rather than maintained twice.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE DIRECTORY NAME OVERSELLS
 * ---------------------------------------------------------------------------
 *
 * "chat-pipeline" and "one pipeline behind two routes" describe the ENTRY, not
 * the turn. The table above argues correctly against merging the two
 * strategies; it does not establish that what remains is DRY, and it is not.
 * Recorded here because two reviews independently measured it, and because the
 * risk is precisely that a reader stops at the sentence above and assumes a fix
 * lands on both surfaces:
 *
 *   - `runPageChatTurn` is ~2,080 lines in ONE function; `runGlobalChatTurn`
 *     ~1,460. Both interleave decision and effect throughout, so neither has an
 *     extractable core that can be unit-tested without a DB and a provider.
 *   - 163 substantive lines of 40+ characters are byte-identical between them
 *     (of 994 and 785 respectively). Measured, not estimated — strip comments
 *     and blanks, compare the sets.
 *   - The longest identical runs are NOT scattered. They cluster at
 *     `page 1758-1915` ≡ `global 1312-1429`: the epilogue — stream
 *     construction, `onFinish`, terminal persist, hold settle, telemetry. That
 *     is the same region that holds the billing settle, `releaseHold`, and the
 *     exactly-once mention latch. Two copies of the money path.
 *
 * That these can drift is not hypothetical: `5c1bc5410` on this very branch is
 * titled "bring the global assistant to parity with the page chat".
 *
 * The extraction that would pay first is the epilogue, as a shared function
 * over a typed turn context — not a merge of the strategies, which the table
 * above still argues against. After it, the decisions worth lifting out as
 * pure functions over injected deps are the ones that are decisions rather
 * than effects: the credit gate, model/provider resolution, plan binding, and
 * tool-set assembly. Each is currently reachable only through a DB and a live
 * provider. Four sibling modules in this same epic
 * (`claim-`/`close-`/`create-`/`reopen-conversation-in-workspace.ts`) carry the
 * repo rule that branching logic belongs in a pure decision; it was applied to
 * those ~40-line helpers and not to the ~3,500 lines here, where it would pay.
 * Deliberately not attempted in the epic that RELOCATED this code from
 * `route.ts` without rewriting it — but the gap should be legible from here
 * rather than rediscovered by measurement.
 */

import { NextResponse } from 'next/server';
import {
  authenticateRequestWithOptions,
  isAuthError,
  isMCPAuthResult,
  type AuthResult,
} from '@/lib/auth';
import { validateBrowserSessionIdHeader } from '@/lib/ai/core/browser-session-id-validation';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { runPageChatTurn } from './page-chat-turn';
import { runGlobalChatTurn } from './global-chat-turn';

/**
 * Which public URL the turn arrived on. It decides the AUTH OPTIONS and the
 * audit vocabulary — the two things that are properties of the surface rather
 * than of the turn — and nothing else. Which STRATEGY runs is decided from the
 * conversation.
 */
export type ChatTurnSurface = 'page-chat' | 'global-messages';

/** `POST /api/ai/chat` has always accepted MCP tokens; that is unchanged. */
const PAGE_CHAT_AUTH = { allow: ['session', 'mcp'] as const, requireCSRF: true };
/** `POST /api/ai/global/[id]/messages` has always been session-only; unchanged. */
const GLOBAL_AUTH = { allow: ['session'] as const, requireCSRF: true };

const MAX_BODY_BYTES = 25 * 1024 * 1024;

interface HandleChatTurnOptions {
  surface: ChatTurnSurface;
  /** The `[id]` segment, on the global URL only. */
  urlConversationId?: string;
}

export async function handleChatTurn(
  request: Request,
  opts: HandleChatTurnOptions,
): Promise<Response> {
  const startTime = Date.now();
  const isPageSurface = opts.surface === 'page-chat';
  const log = isPageSurface ? loggers.ai : loggers.api;

  // 1. Browser session header — identical check, identical error, on both
  //    surfaces, and first on both. A synthetic `agent-dispatch-<id>` is what
  //    server-side dispatch sends.
  const browserSessionIdResult = validateBrowserSessionIdHeader(
    request.headers.get('X-Browser-Session-Id'),
  );
  if (!browserSessionIdResult.ok) {
    return NextResponse.json(
      { error: browserSessionIdResult.message },
      { status: browserSessionIdResult.status },
    );
  }
  const browserSessionId = browserSessionIdResult.browserSessionId;

  // 2. Authentication, with the options THIS SURFACE always used — the page
  //    surface admits MCP tokens, the global surface never has. The audit row
  //    keeps each surface's own resource vocabulary so existing alerting and
  //    the security-audit route coverage still match.
  const auth = await authenticateRequestWithOptions(
    request,
    isPageSurface ? PAGE_CHAT_AUTH : GLOBAL_AUTH,
  );
  if (isAuthError(auth)) {
    if (isPageSurface) {
      loggers.ai.warn('AI Chat API: Authentication failed');
      auditRequest(request, {
        eventType: 'authz.access.denied',
        resourceType: 'ai_chat',
        resourceId: 'post',
        details: { reason: 'auth_failed', method: 'POST', authFailureReason: auth.authFailureReason },
        riskScore: 0.5,
      });
    } else {
      loggers.api.debug('Global Assistant Chat API: Authentication failed', {});
      auditRequest(request, {
        eventType: 'authz.access.denied',
        resourceType: 'global_chat_message',
        resourceId: 'send',
        details: { reason: 'auth_failed', method: 'POST', authFailureReason: auth.authFailureReason },
        riskScore: 0.5,
      });
    }
    return auth.error;
  }

  // 3. Body size guard — before parsing, as on both routes.
  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_BODY_BYTES) {
    log.warn(
      isPageSurface ? 'AI Chat API: Request body too large' : 'Global Assistant Chat API: Request body too large',
      { contentLength },
    );
    return NextResponse.json({ error: 'Request body too large (max 25MB)' }, { status: 413 });
  }

  // 4. Parse. An unparseable body used to fall into each route's own outer
  //    catch, which answered 500 with this exact message — preserved, including
  //    the page route's `success:false` usage row (below), so nothing that
  //    watches these signals sees a change.
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch (error) {
    return unparseableBody(error, auth, isPageSurface, Date.now() - startTime);
  }

  // 5. The strategy decision, and the turn itself.
  return dispatchChatTurn({
    request,
    auth,
    browserSessionId,
    body,
    surface: opts.surface,
    urlConversationId: opts.urlConversationId,
  });
}

/**
 * The strategy decision and the turn — everything after "who is this, and is
 * the body readable".
 *
 * Split from {@link handleChatTurn} so a caller that has ALREADY established
 * its actor by some other means can reach the same decision without inventing a
 * second one. There is exactly one such caller: `POST
 * /api/internal/agent-dispatch`, which authenticates a SERVICE over an HMAC and
 * takes the acting user from the signed payload. It must not re-derive the
 * strategy, or worker dispatch and browser traffic could diverge on which turn
 * a conversation gets.
 *
 * Everything here is byte-identical to what `handleChatTurn` used to run
 * inline; the extraction moves no decision and changes no wire contract.
 */
export async function dispatchChatTurn({
  request,
  auth,
  browserSessionId,
  body,
  surface,
  urlConversationId,
}: {
  request: Request;
  auth: AuthResult;
  browserSessionId: string;
  body: Record<string, unknown>;
  surface: ChatTurnSurface;
  urlConversationId?: string;
}): Promise<Response> {
  const isPageSurface = surface === 'page-chat';

  if (!isPageSurface) {
    return runGlobalChatTurn({
      request,
      auth,
      browserSessionId,
      body,
      urlConversationId,
    });
  }

  //
  //    A request that names a `chatId` is a page-agent turn by definition —
  //    that is what the field has always meant — so it goes straight through
  //    with no extra read and no change of any kind.
  //
  //    A request with NO `chatId` used to be a flat 400. It still is, UNLESS
  //    the `conversationId` it carries resolves to an existing global-assistant
  //    conversation, in which case this URL runs the global strategy. That is
  //    the whole widening, and it is what lets server-side dispatch stop
  //    branching on `agentPageId` to pick a URL.
  //
  //    Fail-closed by construction: the lookup below decides nothing about
  //    authorization. The global strategy re-reads the row through
  //    `resolveOrCreateConversation`, which independently enforces owner +
  //    `type='global'` + `isActive`; a lookup failure here simply falls through
  //    to the unchanged "chatId is required" 400.
  const chatId = typeof body.chatId === 'string' && body.chatId.length > 0 ? body.chatId : undefined;
  if (!chatId) {
    const conversationId =
      typeof body.conversationId === 'string' && body.conversationId.length > 0
        ? body.conversationId
        : undefined;
    if (conversationId) {
      const conversation = await conversationRepository
        .getConversation(conversationId)
        .catch((error: unknown) => {
          loggers.ai.warn('AI Chat API: could not resolve conversation for strategy selection', {
            conversationId,
            error: error instanceof Error ? error.message : 'unknown',
          });
          return null;
        });
      // OWNERSHIP IS PART OF THE SELECTION, not because the global strategy
      // needs it — `resolveOrCreateConversation` re-enforces owner + type +
      // isActive independently — but because WITHOUT it the two branches
      // refuse differently and the difference is observable (review finding —
      // MINOR 3). Someone else's existing global conversation routed to the
      // global strategy and came back `404 "Conversation not found"`, while
      // every other id fell through to `400 "chatId is required"`, so an
      // authenticated caller could tell "this id is an existing global
      // conversation" from everything else. Nothing beyond existence leaked
      // and cuid2 ids are not enumerable, but this codebase refuses uniformly
      // across "forbidden" and "does not exist" everywhere else it decides
      // anything (`authorize-pane-scope.ts`), and the row is already in hand.
      if (conversation && conversation.type === 'global' && conversation.userId === auth.userId) {
        // An MCP token has never been able to drive the global assistant, and
        // this entry must not become the door that lets it. Re-running the
        // session-only options produces the SAME refusal the global URL would
        // have produced, and costs nothing: the bearer prefix is recognised
        // before any I/O.
        if (isMCPAuthResult(auth)) {
          const sessionOnly = await authenticateRequestWithOptions(request, GLOBAL_AUTH);
          if (isAuthError(sessionOnly)) {
            auditRequest(request, {
              eventType: 'authz.access.denied',
              userId: auth.userId,
              resourceType: 'global_chat_message',
              resourceId: 'send',
              details: { reason: 'mcp_token_not_permitted', method: 'POST' },
              riskScore: 0.5,
            });
            return sessionOnly.error;
          }
        }
        return runGlobalChatTurn({
          request,
          auth,
          browserSessionId,
          body,
          // No URL segment on this surface — the body id is the only source,
          // and it is the one that just resolved.
          urlConversationId: undefined,
        });
      }
    }
  }

  return runPageChatTurn({ request, auth, browserSessionId, body });
}

/**
 * The response an unparseable body has always produced, reproduced here so the
 * parse can move up into the shared entry without changing what a malformed
 * request sees — or what it records. Both routes answered 500 with this
 * message; only the page route also wrote a `success:false` AI-usage row, so
 * only the page surface writes one here.
 */
async function unparseableBody(
  error: unknown,
  auth: AuthResult,
  isPageSurface: boolean,
  duration: number,
): Promise<Response> {
  if (isPageSurface) {
    loggers.ai.error('AI Chat API Error', error as Error, {
      userId: auth.userId,
      chatId: undefined,
      provider: undefined,
      model: undefined,
    });
    await AIMonitoring.trackUsage({
      userId: auth.userId || 'unknown',
      provider: 'unknown',
      model: 'unknown',
      source: 'chat',
      duration,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      metadata: { errorType: error instanceof Error ? error.name : 'UnknownError' },
    }).catch(() => {});
  } else {
    loggers.api.error('Global Assistant Chat API Error:', error as Error);
  }
  return NextResponse.json(
    { error: 'Failed to process chat request. Please try again.' },
    { status: 500 },
  );
}
