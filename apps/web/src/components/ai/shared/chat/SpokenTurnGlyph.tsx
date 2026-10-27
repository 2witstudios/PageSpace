import React from 'react';
import { Mic } from 'lucide-react';

import { cn } from '@/lib/utils';
import { VOICE_MESSAGE_SOURCE } from '@/lib/ai/realtime/message-source';
import type { ConversationMessage } from './message-types';

/**
 * The mark on a turn that was SPOKEN rather than typed.
 *
 * WHY THE THREAD HAS TO SAY. Audio is ephemeral and the transcript is the
 * artifact of record — so what lands in the conversation is all that survives a
 * call, and it lands next to typed messages that look exactly like it. A
 * dictated sentence reads differently: it runs long, it repeats itself, it
 * carries whatever the transcriber heard. A reader who does not know it was
 * spoken reads it as someone typing carelessly, and an AGENT re-reading the
 * thread has the same problem. One glyph is the whole fix.
 *
 * Compared through the named constant rather than a `'voice'` literal: it
 * exists precisely so the UI's check, the realtime writer and the seed builder
 * cannot end up on three spellings of one string (see `message-source.ts` for
 * why the browser reads its own copy, and where the drift guard lives).
 */
export const isSpokenTurn = (message: Pick<ConversationMessage, 'source'>): boolean =>
  message.source === VOICE_MESSAGE_SOURCE;

export const SpokenTurnGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <span
    data-testid="spoken-turn-glyph"
    title="Spoken in a voice call"
    className={cn('inline-flex items-center', className)}
  >
    <Mic className="h-3 w-3" aria-hidden="true" />
    {/* Named for screen readers, which get nothing from an icon. */}
    <span className="sr-only">Spoken in a voice call</span>
  </span>
);
