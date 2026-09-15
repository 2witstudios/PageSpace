import type { UIMessage } from 'ai';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { buildAssistantPersistencePayload } from '@/lib/ai/core/persistAssistantParts';
import type { ToolApproval } from '@/lib/ai/core/message-utils';
import { toolApprovalRepository, type ToolApprovalScope } from '@/lib/repositories/tool-approval-repository';
import {
  pageAdapter,
  globalAdapter,
  type AssistantMessageAdapter,
  type FetchedAssistantMessage,
} from '@/lib/ai/core/assistant-message-adapter';

/**
 * Tool-approval RESUME — the server half of the human-in-the-loop gate.
 *
 * The pause is the AI SDK's: a gated tool's `needsApproval` left a tool part in
 * `approval-requested` on the assistant message that ended the turn. The client
 * answers by re-POSTing the chat route with that assistant message trailing,
 * its part flipped to `approval-responded`. This module turns that answer into
 * durable state on the ORIGINAL row, and it is the only place that decides.
 *
 * INVARIANT IT UPHOLDS (see `sanitizeMessagesForModel`): by the time the turn
 * assembles model messages, every `approval-responded` part on the row is a
 * RESULT — `output-available` / `output-error` (executed by the turn, recorded
 * via {@link recordApprovedToolOutcome}) or `output-denied` (refused here). A
 * responded part with no result is exactly the shape that makes the SDK run its
 * own execute-on-resume step, whose output would land under the OLD toolCallId
 * in a NEW message and be lost — and the tool would run again next turn.
 *
 * EXACTLY ONCE. Every state change goes through
 * `toolApprovalRepository.claimDecision` first — one row per approval id, insert
 * on conflict do nothing. Two tabs approving, or an approve racing the typed
 * message that denies, resolve to exactly one winner; losers change nothing.
 *
 * TRUST BOUNDARY. From the client we keep only `{toolCallId, approvalId,
 * approved, reason}`; the approval id must equal the one the server persisted
 * on that part, the row must be the conversation's newest message, and the part
 * must still be `approval-requested`. Everything else — tool name, input, the
 * decision to execute — comes from the persisted row.
 */

export interface ClientToolApprovalResponse {
  toolCallId: string;
  approvalId: string;
  approved: boolean;
  reason?: string;
}

/** approvalId → the standing grant the user asked for alongside "allow". */
export type ToolApprovalScopes = Readonly<Record<string, ToolApprovalScope>>;

const TOOL_APPROVAL_SCOPES: ReadonlySet<string> = new Set(['once', 'conversation', 'always']);

/** The request body's `toolApprovalScopes`, kept only where both key and value are well-formed. */
export function readToolApprovalScopes(raw: unknown): ToolApprovalScopes {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, ToolApprovalScope> = {};
  for (const [approvalId, scope] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof scope === 'string' && TOOL_APPROVAL_SCOPES.has(scope)) out[approvalId] = scope as ToolApprovalScope;
  }
  return out;
}

/** An approved, claimed call the TURN must now run (with its real tool context). */
export interface ApprovedToolExecution {
  approvalId: string;
  toolCallId: string;
  /** The part's tool name as the SDK sees it — `execute_tool` for dispatched calls; the turn's tool set resolves it. */
  toolName: string;
  input: unknown;
}

export type ApplyToolApprovalResult =
  | { kind: 'applied'; approved: ApprovedToolExecution[]; denied: number }
  /** No such assistant row in this conversation. */
  | { kind: 'not_found' }
  /** The row is no longer the newest message — the card is stale; nothing executes. */
  | { kind: 'stale' }
  /** Every response named an id that was already decided (or did not match the row). */
  | { kind: 'already_resolved' };

type ApprovalToolPart = {
  type: string;
  toolCallId: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: ToolApproval;
};

const isToolPart = (part: { type: string }): part is ApprovalToolPart => part.type.startsWith('tool-');

const partToolName = (part: ApprovalToolPart): string => part.toolName ?? part.type.slice('tool-'.length);

const MAX_REASON_CHARS = 500;

export const DISMISSED_APPROVAL_REASON = 'User continued the conversation without approving.';
export const STALE_APPROVAL_REASON = 'The approved call did not run before the conversation continued.';

/**
 * Pull approval responses off a trailing ASSISTANT request message. Only the
 * four fields survive; the merge re-derives everything else from the row.
 */
export function extractClientToolApprovalResponses(
  message: UIMessage | undefined,
): ClientToolApprovalResponse[] {
  if (!message || message.role !== 'assistant' || !message.parts) return [];
  const out: ClientToolApprovalResponse[] = [];
  for (const part of message.parts) {
    if (!isToolPart(part) || part.state !== 'approval-responded') continue;
    const approval = part.approval;
    if (!approval || typeof approval.id !== 'string' || typeof approval.approved !== 'boolean') continue;
    if (typeof part.toolCallId !== 'string') continue;
    const reason = typeof approval.reason === 'string' ? approval.reason.slice(0, MAX_REASON_CHARS) : undefined;
    out.push({ toolCallId: part.toolCallId, approvalId: approval.id, approved: approval.approved, ...(reason ? { reason } : {}) });
  }
  return out;
}

const replacePart = (parts: UIMessage['parts'], toolCallId: string, next: ApprovalToolPart): UIMessage['parts'] =>
  parts.map((part) => (isToolPart(part) && part.toolCallId === toolCallId ? next : part)) as UIMessage['parts'];

const withoutOutput = ({ output: _output, errorText: _errorText, ...rest }: ApprovalToolPart): ApprovalToolPart => rest;

async function applyToolApprovalResponses(
  adapter: AssistantMessageAdapter,
  args: {
    messageId: string;
    conversationId: string;
    userId: string;
    responses: ClientToolApprovalResponse[];
    scopes?: ToolApprovalScopes;
  },
): Promise<ApplyToolApprovalResult> {
  if (args.responses.length === 0) return { kind: 'already_resolved' };

  const fetched = await adapter.fetchById(args.messageId);
  if (!fetched) return { kind: 'not_found' };

  const lastId = await adapter.fetchLastMessageId();
  if (lastId !== args.messageId) {
    loggers.ai.warn('approval resume: card is stale (row is not the newest message)', {
      messageId: args.messageId,
      lastId,
    });
    return { kind: 'stale' };
  }

  const byToolCallId = new Map<string, ApprovalToolPart>();
  for (const part of fetched.message.parts) {
    if (isToolPart(part)) byToolCallId.set(part.toolCallId, part);
  }

  let parts = fetched.message.parts;
  let changed = false;
  const approved: ApprovedToolExecution[] = [];
  let denied = 0;

  for (const response of args.responses) {
    const part = byToolCallId.get(response.toolCallId);
    if (!part || part.state !== 'approval-requested' || part.approval?.id !== response.approvalId) {
      loggers.ai.warn('approval resume: response does not match a pending approval on the row', {
        toolCallId: response.toolCallId,
        approvalId: response.approvalId,
        partState: part?.state,
      });
      continue;
    }

    const toolName = partToolName(part);
    const scope = response.approved ? args.scopes?.[response.approvalId] ?? 'once' : null;
    const won = await toolApprovalRepository.claimDecision({
      approvalId: response.approvalId,
      toolCallId: response.toolCallId,
      toolName,
      messageId: args.messageId,
      conversationId: args.conversationId,
      userId: args.userId,
      approved: response.approved,
      reason: response.reason ?? null,
      scope,
    });
    if (!won) continue;

    const approval: ToolApproval = {
      id: response.approvalId,
      approved: response.approved,
      ...(response.reason ? { reason: response.reason } : {}),
    };
    if (response.approved) {
      parts = replacePart(parts, part.toolCallId, { ...withoutOutput(part), state: 'approval-responded', approval });
      approved.push({ approvalId: response.approvalId, toolCallId: part.toolCallId, toolName, input: part.input });
      if (scope === 'conversation' || scope === 'always') {
        // The grant is on the EFFECTIVE tool: for execute_tool that is the
        // dispatched name, which is what the policy checks next time.
        const effective =
          toolName === 'execute_tool' && typeof (part.input as { tool_name?: unknown })?.tool_name === 'string'
            ? ((part.input as { tool_name: string }).tool_name)
            : toolName;
        await toolApprovalRepository.addGrant({
          userId: args.userId,
          toolName: effective,
          conversationId: scope === 'conversation' ? args.conversationId : null,
        });
      }
    } else {
      parts = replacePart(parts, part.toolCallId, { ...withoutOutput(part), state: 'output-denied', approval });
      denied += 1;
      await toolApprovalRepository.markExecuted(response.approvalId, 'denied');
    }
    changed = true;
  }

  if (!changed) return { kind: 'already_resolved' };

  await fetched.persist(buildAssistantPersistencePayload(args.messageId, parts));
  return { kind: 'applied', approved, denied };
}

/**
 * A new user message arrived instead of an answer, or the turn is starting
 * with leftovers. Every still-pending request on the conversation's last
 * assistant message becomes `output-denied` (claimed, so a concurrent approve
 * from another tab loses), and any `approval-responded` part that never got a
 * result — an approved call whose turn died before it ran — is closed the
 * same way with {@link STALE_APPROVAL_REASON}, so no responded-without-result
 * part ever reaches model assembly.
 */
async function dismissPendingToolApprovals(
  adapter: AssistantMessageAdapter,
  args: { conversationId: string; userId: string },
): Promise<{ denied: number }> {
  const fetched = await adapter.fetchLastAssistant();
  if (!fetched) return { denied: 0 };

  let parts = fetched.message.parts;
  let denied = 0;
  for (const part of fetched.message.parts) {
    if (!isToolPart(part)) continue;
    if (part.state !== 'approval-requested' && part.state !== 'approval-responded') continue;
    const approvalId = part.approval?.id;
    if (!approvalId) continue;

    const stale = part.state === 'approval-responded';
    const reason = stale ? STALE_APPROVAL_REASON : DISMISSED_APPROVAL_REASON;
    if (!stale) {
      const won = await toolApprovalRepository.claimDecision({
        approvalId,
        toolCallId: part.toolCallId,
        toolName: partToolName(part),
        messageId: fetched.message.id,
        conversationId: args.conversationId,
        userId: args.userId,
        approved: false,
        reason,
        scope: null,
      });
      if (!won) continue;
    }
    parts = replacePart(parts, part.toolCallId, {
      ...withoutOutput(part),
      state: 'output-denied',
      approval: { id: approvalId, approved: false, reason },
    });
    await toolApprovalRepository.markExecuted(approvalId, stale ? 'stale' : 'denied');
    denied += 1;
  }

  if (denied === 0) return { denied: 0 };
  await fetched.persist(buildAssistantPersistencePayload(fetched.message.id, parts));
  return { denied };
}

export type ApprovedToolOutcome = { ok: true; output: unknown } | { ok: false; errorText: string };

/**
 * The turn ran (or failed to run) an approved call: make the result durable on
 * the original row. Only a part still in `approval-responded` is written —
 * a second report for the same call is a no-op.
 */
async function recordApprovedToolOutcome(
  adapter: AssistantMessageAdapter,
  args: { messageId: string; toolCallId: string; approvalId: string; outcome: ApprovedToolOutcome },
): Promise<{ recorded: boolean; message: FetchedAssistantMessage | null }> {
  const fetched = await adapter.fetchById(args.messageId);
  if (!fetched) return { recorded: false, message: null };

  const part = (fetched.message.parts as Array<{ type: string }>).find(
    (candidate) => isToolPart(candidate) && candidate.toolCallId === args.toolCallId,
  ) as ApprovalToolPart | undefined;
  if (!part || part.state !== 'approval-responded') return { recorded: false, message: fetched };

  const next: ApprovalToolPart = args.outcome.ok
    ? { ...withoutOutput(part), state: 'output-available', output: args.outcome.output }
    : { ...withoutOutput(part), state: 'output-error', errorText: args.outcome.errorText };
  const parts = replacePart(fetched.message.parts, args.toolCallId, next);
  await fetched.persist(buildAssistantPersistencePayload(args.messageId, parts));
  await toolApprovalRepository.markExecuted(args.approvalId, args.outcome.ok ? 'ok' : 'error');
  return { recorded: true, message: fetched };
}

// --- Page (page-agent) conversations -------------------------------------

export function applyToolApprovalResponsesToPageMessage(args: {
  messageId: string;
  pageId: string;
  conversationId: string;
  userId: string;
  responses: ClientToolApprovalResponse[];
  scopes?: ToolApprovalScopes;
}): Promise<ApplyToolApprovalResult> {
  return applyToolApprovalResponses(pageAdapter(args), args);
}

export function dismissPendingToolApprovalsForPageConversation(args: {
  pageId: string;
  conversationId: string;
  userId: string;
}): Promise<{ denied: number }> {
  return dismissPendingToolApprovals(pageAdapter(args), args);
}

export function recordApprovedToolOutcomeOnPageMessage(args: {
  pageId: string;
  conversationId: string;
  messageId: string;
  toolCallId: string;
  approvalId: string;
  outcome: ApprovedToolOutcome;
}): Promise<{ recorded: boolean; message: FetchedAssistantMessage | null }> {
  return recordApprovedToolOutcome(pageAdapter(args), args);
}

// --- Global Assistant conversations --------------------------------------

export function applyToolApprovalResponsesToGlobalMessage(args: {
  messageId: string;
  conversationId: string;
  userId: string;
  responses: ClientToolApprovalResponse[];
  scopes?: ToolApprovalScopes;
}): Promise<ApplyToolApprovalResult> {
  return applyToolApprovalResponses(globalAdapter(args), args);
}

export function dismissPendingToolApprovalsForGlobalConversation(args: {
  conversationId: string;
  userId: string;
}): Promise<{ denied: number }> {
  return dismissPendingToolApprovals(globalAdapter(args), args);
}

export function recordApprovedToolOutcomeOnGlobalMessage(args: {
  conversationId: string;
  messageId: string;
  toolCallId: string;
  approvalId: string;
  outcome: ApprovedToolOutcome;
}): Promise<{ recorded: boolean; message: FetchedAssistantMessage | null }> {
  return recordApprovedToolOutcome(globalAdapter(args), args);
}
