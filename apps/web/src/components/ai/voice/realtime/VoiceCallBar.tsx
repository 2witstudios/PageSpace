'use client';

import { Loader2, Mic, MicOff, PhoneOff } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAudioLevel } from '@/hooks/voice/useAudioLevel';
import { useVoiceSession, useVoiceSessionControls } from '@/contexts/VoiceSessionContext';
import { describeCall, isCallLive } from '@/lib/ai/realtime/call-chrome';

export interface VoiceCallBarProps {
  /** The assistant this call is bound to, named the way the surface names it. */
  assistantName: string;
  className?: string;
}

const METER_BARS = 5;

/**
 * The live call, as a header on the chat surface it belongs to.
 *
 * VOICE IS A MODE, NOT A PANEL. This bar sits above the SAME message list, in
 * the SAME conversation, on the surface that was already showing that
 * conversation. It is not a fourth sidebar tab and not an overlay, because
 * either of those would make the spoken turns a separate place with a separate
 * history — and the whole claim of audio-native voice here is that there is one
 * substrate and speaking is just another way into it.
 *
 * WHY IT SHOWS NO ERROR STATE. A failed connect clears the binding in the
 * provider (`setTarget(null)`), so there is no longer a conversation for this
 * bar to belong to — and a surface that reported an error for a call it can no
 * longer identify would report OTHER surfaces' failures too. Failures are the
 * nav trigger's job, as a toast, which reaches the user on every route
 * including the ones where this panel is collapsed and this component does not
 * exist. One reporter, and the one that is always mounted.
 *
 * WHAT IT DELIBERATELY DOES NOT RENDER: the transcript. Spoken turns are
 * written into the conversation by the realtime server and arrive on the
 * ordinary `conversation:*` socket events, so they appear in the message list
 * below as ordinary messages, marked with a mic glyph. Rendering them here as
 * well would be a second copy of the record, drifting from the first, and would
 * be exactly the "second history" the design forbids. The one thing shown is
 * the CURRENT utterance — which has not been persisted yet and therefore exists
 * nowhere else.
 */
export function VoiceCallBar({ assistantName, className }: VoiceCallBarProps) {
  const { status, error, failure, attached, target, userSpeaking, transcript, tools, localStream, muted } =
    useVoiceSession();
  const { stop, setMuted } = useVoiceSessionControls();

  const chrome = describeCall({ status, error, failure, attached, bound: target !== null });
  const live = isCallLive(chrome.state);

  // Metered from the user's own microphone, and only while unmuted: a meter
  // that keeps moving after mute is a UI telling the user they are still being
  // heard when the entire point of the button they just pressed is that they
  // are not.
  const level = useAudioLevel(localStream, live && !muted);

  const latest = transcript.length > 0 ? transcript[transcript.length - 1] : undefined;
  const latestTool = tools.length > 0 ? tools[tools.length - 1] : undefined;

  const statusLine = (() => {
    if (chrome.state === 'connecting') return 'Connecting…';
    if (muted) return 'Muted';
    if (latestTool) return latestTool.speech;
    if (userSpeaking) return 'Listening…';
    return `Talking to ${assistantName}`;
  })();

  return (
    <div
      data-testid="voice-call-bar"
      data-voice-state={chrome.state}
      className={cn(
        'flex flex-col gap-1 border-b border-[var(--separator)] bg-primary/5 px-3 py-2',
        chrome.state === 'degraded' && 'bg-amber-500/10',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        {/* Level meter — the "is it hearing me" signal, before any words exist. */}
        <div
          data-testid="voice-level-meter"
          aria-hidden="true"
          className="flex h-5 shrink-0 items-end gap-0.5"
        >
          {Array.from({ length: METER_BARS }, (_, index) => {
            const lit = level > index / METER_BARS;
            return (
              <span
                key={index}
                className={cn(
                  'w-0.5 rounded-full transition-all duration-75',
                  lit ? 'bg-primary' : 'bg-muted-foreground/25',
                )}
                style={{ height: `${6 + index * 3}px` }}
              />
            );
          })}
        </div>

        <div className="min-w-0 flex-1">
          {latest ? (
            <p className="truncate text-xs italic text-muted-foreground">
              &ldquo;{latest.text}&rdquo;
            </p>
          ) : (
            <p className="truncate text-xs text-muted-foreground">{statusLine}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {chrome.state === 'connecting' ? (
            <Loader2
              data-testid="voice-call-connecting"
              className="h-4 w-4 animate-spin text-muted-foreground"
            />
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setMuted(!muted)}
              disabled={!live}
              aria-pressed={muted}
              aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
              data-testid="voice-mute-toggle"
            >
              {muted ? (
                <MicOff className="h-3.5 w-3.5 text-destructive" />
              ) : (
                <Mic className="h-3.5 w-3.5" />
              )}
            </Button>
          )}

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            onClick={stop}
            aria-label="End voice call"
            data-testid="voice-end-call"
          >
            <PhoneOff className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/*
        The degradation notice. Told, never inferred: a call whose transcript is
        not being written looks exactly like one whose transcript is, right up
        until the user hangs up and finds nothing in the thread. It stays
        visible for the whole call rather than fading, because the fact it
        states is true for the whole call.
      */}
      {chrome.state === 'degraded' && chrome.detail && (
        <p
          data-testid="voice-call-detail"
          className="text-[11px] leading-tight text-amber-700 dark:text-amber-400"
        >
          {chrome.detail}
        </p>
      )}
    </div>
  );
}
