import { createContext, useContext } from 'react';
import type { ToolApprovalDecision } from '@/lib/ai/shared/hooks/useRespondToApproval';

export interface ToolApprovalContextValue {
  /** toolCallIds of paused tool parts answerable in THIS chat instance (last message, chat idle). */
  approvableToolCallIds: ReadonlySet<string>;
  respond: (toolCallId: string, decision: ToolApprovalDecision) => void;
}

/**
 * Carries approval plumbing from a chat surface down to ToolApprovalCard
 * without prop-drilling through ToolCallRenderer/CompactToolCallRenderer,
 * which receive only the part — the approval twin of AskUserAnswerContext.
 *
 * Absent (null) for any renderer outside a live chat surface — historical
 * fetches, other viewers, channel mentions — so those render read-only by
 * construction: the card shows what was asked, never a button.
 */
const ToolApprovalContext = createContext<ToolApprovalContextValue | null>(null);

export const ToolApprovalProvider = ToolApprovalContext.Provider;

export function useToolApprovalContext(): ToolApprovalContextValue | null {
  return useContext(ToolApprovalContext);
}
