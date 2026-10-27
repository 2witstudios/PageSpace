import { createContext, useContext } from 'react';
import type { PausingToolName } from '@/lib/ai/tools/pausing-tools';

export interface AskUserAnswerContextValue {
  /** toolCallIds currently answerable in THIS chat instance (last message, chat idle) — ask_user AND request_env_approval parts. */
  answerableToolCallIds: ReadonlySet<string>;
  /** Submit a pausing tool's client result; `tool` defaults to ask_user. */
  submitAnswers: (toolCallId: string, output: unknown, tool?: PausingToolName) => void;
}

/**
 * Carries answer plumbing from a chat surface (AgentPageView, GlobalAssistantView,
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
