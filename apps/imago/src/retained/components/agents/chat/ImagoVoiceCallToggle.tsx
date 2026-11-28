'use client';

import { useEffect, useRef } from 'react';
import { AudioLines } from 'lucide-react';
import { toast } from 'sonner';
import { useVoiceSession, useVoiceSessionControls } from '@/retained/contexts/VoiceSessionContext';
import { agentTarget, isCallOnConversation } from '@/retained/lib/ai/realtime/voice-binding';
import { describeCall, isCallLive } from '@/retained/lib/ai/realtime/call-chrome';
import { isOnPrem } from '@/retained/lib/deployment-mode';

/**
 * Imago's "Voice call" toggle in the composer row. Pressed = a call is live on
 * THIS conversation. Pressing starts a call on it (a call on another conversation
 * is rebound by the session) or, while live, ends it.
 *
 * A failed start leaves the session unbound, so the toggle reads unpressed; the
 * session's own error sentence is surfaced as a toast, as the classic trigger does.
 * Hidden on-prem, where voice (an external realtime service) is not available.
 */
export function ImagoVoiceCallToggle({ agentId, conversationId }: {
  /** The agent page this conversation belongs to. */
  agentId: string;
  conversationId: string;
}) {
  const { status, error, failure, attached, target } = useVoiceSession();
  const { start, stop } = useVoiceSessionControls();
  const chrome = describeCall({ status, error, failure, attached, bound: target !== null });
  const pressed = isCallOnConversation(target, conversationId) && isCallLive(chrome.state);

  const reportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (chrome.state !== 'error') {
      reportedRef.current = null;
      return;
    }
    const sentence = chrome.detail;
    if (sentence === null || reportedRef.current === sentence) return;
    reportedRef.current = sentence;
    toast.error(sentence);
  }, [chrome.state, chrome.detail]);

  if (isOnPrem()) return null;

  const press = () => {
    if (pressed) {
      stop();
      return;
    }
    start(agentTarget(agentId, conversationId)).catch((caught: unknown) => {
      toast.error('Could not start the call', {
        description: caught instanceof Error ? caught.message : 'Try again in a moment.',
      });
    });
  };

  return (
    <button
      type="button"
      aria-label="Voice call"
      aria-pressed={pressed}
      title="Voice call"
      className={`flex h-8 w-8 items-center justify-center self-center rounded-md hover:bg-accent hover:text-foreground disabled:opacity-50 ${pressed ? 'text-primary' : 'text-muted-foreground'}`}
      onClick={press}
    >
      <AudioLines className="h-4 w-4" />
    </button>
  );
}
