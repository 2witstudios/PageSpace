/**
 * Pure functions for building stable useChat configurations.
 *
 * The AI SDK's useChat hook recreates its internal Chat instance when the `id`
 * prop changes (chat.react.ts → shouldRecreateChat). Recreation clobbers any
 * messages written by setMessages, producing blank screens and stale history.
 *
 * The fix: give every useChat a stable `id` tied to the surface, not the
 * conversation. Messages flow through setMessages exclusively — the `messages`
 * prop is construction-only and silently ignored after the first render.
 *
 * @see https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat — id: "A unique identifier for the chat."
 * @see vercel/ai packages/react/src/use-chat.ts — shouldRecreateChat checks id only
 */

import type { DefaultChatTransport, UIMessage } from 'ai';

/**
 * Stable chat IDs per surface. These never change across conversation switches
 * within the same surface, preventing Chat instance recreation.
 */
export const GLOBAL_CHAT_ID = 'global-assistant';
export const AGENT_CHAT_ID = 'agent-chat';
export const SIDEBAR_AGENT_CHAT_ID = 'sidebar-agent';

/**
 * Parameters for building a useChat config object.
 */
export interface ChatConfigParams {
  /** Stable surface ID (use constants above or page.id for AiChatView). */
  id: string;
  /** Transport instance from useChatTransport. */
  transport: DefaultChatTransport<UIMessage>;
  /** Throttle in ms for UI updates. Defaults to 100. */
  throttleMs?: number;
  /** Error handler. */
  onError?: (error: Error) => void;
}

/**
 * Build a useChat config object with a stable id and no messages prop.
 *
 * Pure: same inputs always produce the same output. No side effects.
 *
 * The messages prop is intentionally omitted — useChat only reads it during
 * Chat construction (first render). After that, setMessages is the sole writer.
 * Including messages in the config creates a false dependency that useChat
 * silently ignores, making the code harder to reason about.
 */
export function buildChatConfig(params: ChatConfigParams): {
  id: string;
  transport: DefaultChatTransport<UIMessage>;
  experimental_throttle: number;
  onError: (error: Error) => void;
} {
  return {
    id: params.id,
    transport: params.transport,
    experimental_throttle: params.throttleMs ?? 100,
    onError: params.onError ?? defaultOnError,
  };
}

const defaultOnError = (error: Error): void => {
  console.error('Chat error:', error);
};
