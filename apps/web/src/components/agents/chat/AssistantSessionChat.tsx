'use client';

/**
 * AssistantSessionChat — the GLOBAL ASSISTANT in a session pane.
 *
 * `SessionChat`'s counterpart for a conversation with no agent page
 * (`agentPageId: null`): identical surface (`SessionChatView`), other pipeline
 * (`useAssistantSessionChat` — global channel, global endpoint, global loader;
 * see that hook's substitution table). The display name is fixed — the
 * assistant is the user's own, not a page with a title — and the vision gate
 * reads the assistant's selected model from the same settings store the send
 * path does, so the composer and the request can never disagree about which
 * model is being asked.
 */
import { useAssistantSettingsStore } from '@/stores/useAssistantSettingsStore';
import { SessionChatView } from './SessionChat';
import { useAssistantContextRef, useAssistantSessionChat } from './useAssistantSessionChat';

export default function AssistantSessionChat({
  sessionId,
  conversationId,
  driveId,
  context,
  isReadOnly = false,
}: {
  /** This conversation's pane-hosting session — see `SessionChatViewProps.sessionId`. */
  sessionId: string | null;
  conversationId: string;
  /** The session's own drive, when it has one — see `useAssistantSessionChat`'s doc. */
  driveId: string | null;
  context: 'page' | 'console';
  isReadOnly?: boolean;
}) {
  const chat = useAssistantSessionChat({ conversationId, driveId });
  const currentModel = useAssistantSettingsStore((state) => state.currentModel);
  // Same ref the turn itself ships, so the `/` picker scopes to exactly the
  // drive `global-chat-turn` will resolve — including the case this session
  // has no drive of its own but the pathname stands in one.
  const contextRef = useAssistantContextRef(driveId);

  return (
    <SessionChatView
      sessionId={sessionId}
      conversationId={conversationId}
      chat={chat}
      name="Global Assistant"
      visionModel={currentModel || ''}
      commandDriveId={contextRef.driveId ?? null}
      context={context}
      isReadOnly={isReadOnly}
    />
  );
}
