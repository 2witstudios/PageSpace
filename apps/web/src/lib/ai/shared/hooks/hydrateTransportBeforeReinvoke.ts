import type { UIMessage } from 'ai';

/**
 * TRANSITIONAL (epic leaf 6.1/6.3 cross-cutting note; deletion covenant on the
 * convergence contract, page kw69qhfck96jpssdk6w2xtbp): `addToolResult` and
 * `regenerate` operate on useChat's INTERNAL messages array (verified
 * ai@6.0.212 index.mjs:13597-13628), which is EMPTY after a reload under
 * store-first rendering — every re-invocation of either must first copy the
 * selector's settled snapshot into it, or the SDK throws on an undefined last
 * message / re-POSTs an empty array (route 400 "messages are required").
 *
 * This copies state between two stateful containers (useChat's array and the
 * conversation cache), which rail 11 otherwise forbids — this is the one
 * carved-out exception, alongside the own-stream mirror. Skipped while this
 * surface's own send is live: the transport array is the mirror's read source
 * then, and overwriting it would break the mirror mid-stream.
 *
 * DELETE ME at the SDK 7 transport swap — WorkflowChatTransport feeds
 * usePendingStreamsStore directly and neither addToolResult nor regenerate
 * will depend on useChat's internal array anymore.
 */
export const hydrateTransportBeforeReinvoke = (
  setMessages: (messages: UIMessage[]) => void,
  stableMessages: UIMessage[],
  isOwnSendLive: boolean,
): void => {
  if (!isOwnSendLive) {
    setMessages(stableMessages);
  }
};
