import type { UIMessage } from 'ai';
import { getAssistantMessagesAfterLastUser } from './getAssistantMessagesAfterLastUser';

const textOf = (message: UIMessage): string =>
  (message.parts ?? [])
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');

/**
 * Plain-text speech source for "read aloud": every assistant message since
 * the user's last turn, joined in order. An agent can emit several
 * consecutive assistant messages (tool calls, intermediate steps, a final
 * reply) before control returns to the user, so this reads all of them
 * rather than just the latest one.
 */
export function getTextSinceLastUserTurn(messages: readonly UIMessage[]): string {
  return getAssistantMessagesAfterLastUser(messages)
    .map(textOf)
    .filter(Boolean)
    .join('\n\n');
}
