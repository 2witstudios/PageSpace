import type { UIMessage } from 'ai';

/**
 * Client-side predicates for the tool-approval gate — the approval twin of
 * `ask-user-client.ts`.
 *
 * A tool part is PENDING approval when the server paused on it
 * (`approval-requested`) and RESPONDED once the user has answered locally
 * (`approval-responded`, with `approval.approved` set). A turn resumes only
 * once every pending approval on the last assistant message has been
 * answered — approving the first of two records a patch and sends nothing.
 *
 * Deliberately NOT the SDK's `lastAssistantMessageIsCompleteWithApprovalResponses`:
 * that helper scopes to the last `step-start`, which PageSpace's persisted rows do
 * not carry, and it would also fire for a turn with no approvals at all once the
 * executed `finish` tool is on it. Scoping to approval states specifically avoids
 * both.
 */

export type ApprovalToolPartState = 'approval-requested' | 'approval-responded';

interface ApprovalCarryingPart {
  type: string;
  toolCallId?: string;
  state?: string;
  approval?: { id?: unknown; approved?: unknown; reason?: unknown };
}

export const isToolPartType = (part: { type: string }): boolean => part.type.startsWith('tool-');

export const isPendingApprovalPart = (part: { type: string; state?: string }): boolean =>
  isToolPartType(part) && part.state === 'approval-requested';

export const isRespondedApprovalPart = (part: { type: string; state?: string; approval?: unknown }): boolean =>
  isToolPartType(part) &&
  part.state === 'approval-responded' &&
  typeof (part as ApprovalCarryingPart).approval?.approved === 'boolean';

/**
 * Resume predicate: the last message is an assistant message that carries at
 * least one approval part, and every one of them has been responded to.
 */
export function toolApprovalsComplete({ messages }: { messages: UIMessage[] }): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || !last.parts) return false;

  const approvalParts = last.parts.filter(
    (part) => isPendingApprovalPart(part) || isRespondedApprovalPart(part),
  );
  if (approvalParts.length === 0) return false;

  return approvalParts.every((part) => isRespondedApprovalPart(part));
}
