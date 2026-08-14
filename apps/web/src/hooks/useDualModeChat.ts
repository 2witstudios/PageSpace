import { useMemo, useCallback, useRef } from 'react';
import { UIMessage } from 'ai';
import { useChatSession, type ChatSessionStatus } from '@/lib/ai/shared/hooks/useChatSession';
import type { AgentInfo } from '@/types/agent';

/**
 * Return type for the unified dual-mode chat interface.
 */
export interface UseDualModeChatReturn {
  /** Send a message into `conversationId` — parts-form, client-minted id preserved end to end. */
  sendMessage: (
    message: UIMessage,
    conversationId: string,
    options?: { body?: Record<string, unknown> },
  ) => Promise<void>;
  /** The ACTIVE mode's send status for the conversation on screen. */
  status: ChatSessionStatus;
  /** Current error (if any) for the active mode's conversation. */
  error: Error | undefined;
  /** Clear current error state */
  clearError: () => void;
  /** Regenerate the last response in `conversationId`. */
  regenerate: (conversationId: string, options?: { body?: Record<string, unknown> }) => Promise<void>;
  /** Global mode status (for syncing to context) */
  globalStatus: ChatSessionStatus;
  /** Agent mode status. */
  agentStatus: ChatSessionStatus;
  /** Add a client-side tool result (mode-selected) — used by ask_user answers */
  addToolResult: (args: {
    tool: string;
    toolCallId: string;
    output: unknown;
    conversationId: string;
    options?: { body?: Record<string, unknown> };
  }) => Promise<void>;
}

interface UseDualModeChatOptions {
  /** Currently selected agent (null = default mode) */
  selectedAgent: AgentInfo | null;
  /** The socket channel + conversation for the surface's null selection (global assistant). */
  global: {
    api: string;
    channelId: string | null;
    conversationId: string | null;
    getBaseMessages: () => UIMessage[];
    onError?: (error: Error) => void;
  };
  /** The socket channel + conversation for agent mode. */
  agent: {
    api: string;
    channelId: string | null;
    conversationId: string | null;
    getBaseMessages: () => UIMessage[];
    onError?: (error: Error) => void;
  };
  /** Identity for the optimistic store entry a send opens. `userId` is what `isOwnStream` compares. */
  triggeredBy: { userId: string; displayName: string };
}

/**
 * Manages chat for a dual-mode surface (sidebar, machine pane), handling both the default
 * (null-selection) and agent modes.
 *
 * ── THE TWO MODE-SWITCH STOPS ARE GONE, AND WERE NOT REPLACED ─────────────────────────────
 *
 * Two effects used to live here:
 *
 *     useEffect(() => { if (selectedAgent && globalIsBusy) globalStop(); }, ...)
 *     useEffect(() => { if (!selectedAgent && agentIsBusy) agentStop(); }, ...)
 *
 * "Stop the global stream when switching to agent mode", and its mirror. They were necessary
 * under the old design for a reason that no longer exists — one `Chat` per mode, each holding
 * a response body, and a surface that could only usefully read one at a time — and they were
 * wrong for a reason that always existed: SWITCHING WHICH MODE YOU ARE LOOKING AT IS NOT A
 * STOP.
 *
 * The residual was documented and accepted on the grounds that "the server generation
 * continues". That is true and it is the half that does not matter. The user's rule has two
 * clauses: (a) do not abort the compute, (b) do not end the run's VISIBLE life. Only (a) was
 * ever reasoned about. In practice a glance at the other mode froze the reply you had left —
 * tokens kept arriving on a channel this tab had stopped reading, and what you came back to
 * was whatever had landed before you looked away.
 *
 * Nothing replaces them. Both modes' streams live in the same store, written by the same
 * app-wide session registry, and neither is coupled to a component or a body. Selecting a mode
 * now changes only which of the two the surface displays.
 * `only-a-deliberate-stop.test.ts` fails if either comes back.
 *
 * There is also no `stop` on the returned interface at all — the one Stop is `useStopStream`,
 * which reaches `/api/ai/abort`.
 */
export function useDualModeChat({
  selectedAgent,
  global,
  agent,
  triggeredBy,
}: UseDualModeChatOptions): UseDualModeChatReturn {
  // Two independent shells. Unlike the two `Chat` instances they replace, both can have sends
  // in flight simultaneously and neither constrains the other — a shell is a `fetch` wrapper
  // with per-conversation state, not a single-body reader.
  const globalChat = useChatSession({
    api: global.api,
    channelId: global.channelId,
    conversationId: global.conversationId,
    triggeredBy,
    getBaseMessages: global.getBaseMessages,
    onError: global.onError,
  });

  const agentChat = useChatSession({
    api: agent.api,
    channelId: agent.channelId,
    conversationId: agent.conversationId,
    triggeredBy,
    getBaseMessages: agent.getBaseMessages,
    onError: agent.onError,
  });

  // NO clear-messages-on-switch effect: rendering is per-conversation from the shared
  // conversation cache, so nothing a mode holds locally can render under the other.

  // Read at CALL time so a mode switch between render and dispatch cannot send into the wrong
  // one — the same reason the conversation id is an argument rather than a latch.
  const modeRef = useRef(selectedAgent);
  modeRef.current = selectedAgent;
  const globalChatRef = useRef(globalChat);
  globalChatRef.current = globalChat;
  const agentChatRef = useRef(agentChat);
  agentChatRef.current = agentChat;

  const active = () => (modeRef.current ? agentChatRef.current : globalChatRef.current);

  const sendMessage = useCallback(
    (message: UIMessage, conversationId: string, options?: { body?: Record<string, unknown> }) =>
      active().sendMessage(message, conversationId, options),
    [],
  );

  const regenerate = useCallback(
    (conversationId: string, options?: { body?: Record<string, unknown> }) =>
      active().regenerate(conversationId, options),
    [],
  );

  const addToolResult = useCallback(
    (args: {
      tool: string;
      toolCallId: string;
      output: unknown;
      conversationId: string;
      options?: { body?: Record<string, unknown> };
    }) => active().addToolResult(args),
    [],
  );

  const clearError = useCallback(() => active().clearError(), []);

  const status = selectedAgent ? agentChat.status : globalChat.status;
  const error = selectedAgent ? agentChat.error : globalChat.error;

  return useMemo(
    () => ({
      sendMessage,
      status,
      error,
      clearError,
      regenerate,
      addToolResult,
      globalStatus: globalChat.status,
      agentStatus: agentChat.status,
    }),
    [
      sendMessage,
      status,
      error,
      clearError,
      regenerate,
      addToolResult,
      globalChat.status,
      agentChat.status,
    ],
  );
}
