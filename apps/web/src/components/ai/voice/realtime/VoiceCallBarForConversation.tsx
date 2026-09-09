'use client';

import { useVoiceSession } from '@/contexts/VoiceSessionContext';
import { isCallOnConversation } from '@/lib/ai/realtime/voice-binding';
import { VoiceCallBar } from './VoiceCallBar';

export interface VoiceCallBarForConversationProps {
  /** The conversation this surface is showing. `null` while it is resolving. */
  conversationId: string | null;
  /** How this surface names the assistant on screen. */
  assistantName: string;
}

/**
 * The call header, IF the live call is on this surface's conversation.
 *
 * WHY THIS EXISTS AS A COMPONENT rather than as an `&&` inside each chat
 * surface. It is mounted by `SidebarChatTab` and `GlobalAssistantView`, both of
 * which are ~1000-line files with enormous hook graphs that the repo does not
 * render in tests. A gate written inline in each would be two copies of one
 * decision, in the two files least likely to be covered — and the decision has
 * a specific wrong answer that looks right: keying on WHICH SURFACE STARTED THE
 * CALL instead of on the conversation. That version works until the user walks
 * from the sidebar to the dashboard mid-call, at which point the call is live
 * with no chrome anywhere and no way to end it but the nav trigger.
 *
 * Here, the decision is one line, in one place, and exercisable against a real
 * session.
 */
export function VoiceCallBarForConversation({
  conversationId,
  assistantName,
}: VoiceCallBarForConversationProps) {
  const { target } = useVoiceSession();
  if (!isCallOnConversation(target, conversationId)) return null;
  return <VoiceCallBar assistantName={assistantName} />;
}
