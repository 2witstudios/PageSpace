import { createContext, useContext } from 'react';
import type { AskUserOutput } from '@/lib/ai/tools/ask-user-tools';

export interface AskUserAnswerContextValue {
  /** toolCallIds currently answerable in THIS chat instance (last message, chat idle). */
  answerableToolCallIds: ReadonlySet<string>;
  submitAnswers: (toolCallId: string, output: AskUserOutput) => void;
}

/**
 * Carries answer plumbing from a chat surface (AiChatView, GlobalAssistantView,
 * SidebarChatTab) down to AskUserQuestionCard without prop-drilling through
 * ToolCallRenderer/CompactToolCallRenderer, which receive only the part.
 *
 * Absent (null) for any renderer outside a live chat surface — historical
 * fetches, other viewers, channel mentions — so those render read-only by
 * construction.
 */
const AskUserAnswerContext = createContext<AskUserAnswerContextValue | null>(null);

export const AskUserAnswerProvider = AskUserAnswerContext.Provider;

export function useAskUserAnswerContext(): AskUserAnswerContextValue | null {
  return useContext(AskUserAnswerContext);
}
