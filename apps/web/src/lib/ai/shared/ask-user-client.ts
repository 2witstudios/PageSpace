import type { UIMessage } from 'ai';
import { isPausingToolPartType } from '@/lib/ai/tools/pausing-tools';

/**
 * sendAutomaticallyWhen predicate: auto-resubmit ONLY once every ask_user
 * question on the last assistant message has been answered.
 *
 * Deliberately NOT the stock `lastAssistantMessageIsCompleteWithToolCalls` —
 * every PageSpace turn ends with the executed `finish` tool (which has an
 * `execute` and so is always "complete"), so that helper would auto-resubmit
 * after every normal turn and loop forever. Scoping the check to ask_user
 * parts specifically avoids that.
 */
export function askUserAnswersComplete({ messages }: { messages: UIMessage[] }): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || !last.parts) return false;

  // Every PAUSING tool part (ask_user, request_env_approval) must be answered before the turn resumes.
  const askParts = last.parts.filter((part) => isPausingToolPartType(part.type));
  if (askParts.length === 0) return false;

  return askParts.every((part) => {
    const state = (part as { state?: string }).state;
    return state === 'output-available' || state === 'output-error';
  });
}
