/**
 * Pull the `conversationId` out of a chat POST's request body, for scoping the consuming mark
 * (see `consumingChannels.ts`).
 *
 * Body-derived, deliberately NOT a live ref/getter: the AI SDK's `sendAutomaticallyWhen`
 * auto-resend re-fires the transport with the ORIGINAL request's body after the surface may have
 * moved to another conversation — the body is the only value guaranteed to name where the POST
 * actually goes. Every chat send path puts `conversationId` at the top level of its JSON body
 * (`global-chat-request-body.ts`, `buildSidebarChatRequestBody`, AiChatView's send body).
 *
 * Returns undefined for anything unparseable or missing — the caller then falls back to the
 * channel-wide consuming mark, which is conservative (over-reports, never double-renders).
 */
export const extractConversationIdFromBody = (body: unknown): string | undefined => {
  if (typeof body !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const conversationId = (parsed as Record<string, unknown>).conversationId;
    return typeof conversationId === 'string' && conversationId.length > 0
      ? conversationId
      : undefined;
  } catch {
    return undefined;
  }
};
