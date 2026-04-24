'use client';

import React, { useEffect, useCallback, useRef, useState } from 'react';
import { Loader2, Mic, MicOff, Settings2, Volume2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useVoiceMode } from '@/hooks/useVoiceMode';
import { useVoiceModeStore, type VoiceModeOwner } from '@/stores/useVoiceModeStore';
import { VoiceModeSettings } from './VoiceModeSettings';

export interface VoiceResponse {
  id: string;
  text: string;
}

export interface VoiceCallPanelProps {
  owner: VoiceModeOwner;
  onSend: (text: string) => void;
  latestAssistantMessage?: VoiceResponse | null;
  isAIStreaming?: boolean;
  streamingText?: string | null;
  onStopStream?: () => void;
  onClose?: () => void;
  className?: string;
}

export function VoiceCallPanel({
  owner,
  onSend,
  latestAssistantMessage,
  isAIStreaming = false,
  streamingText,
  onStopStream,
  onClose,
  className,
}: VoiceCallPanelProps) {
  const [showSettings, setShowSettings] = useState(false);
  const spokenMessageIdsRef = useRef<Set<string>>(new Set());
  const hasAutoStartedRef = useRef(false);
  const streamingSpokenRef = useRef(0);
  const pendingTextRef = useRef('');

  const activeOwner = useVoiceModeStore((state) => state.owner);
  const isEnabled = useVoiceModeStore((state) => state.isEnabled);

  const {
    hasLoadedSettings,
    isListening,
    isProcessing,
    isSpeaking,
    voiceState,
    currentTranscript,
    error,
    disable,
    startListening,
    stopListening,
    speak,
    queueSentence,
    bargeIn,
    interactionMode,
  } = useVoiceMode({
    onSend,
    onStopStream,
  });

  const isOwnerActive = isEnabled && activeOwner === owner;

  // Reset auto-start flag when ownership changes
  useEffect(() => {
    if (!isOwnerActive) {
      hasAutoStartedRef.current = false;
      spokenMessageIdsRef.current.clear();
    }
  }, [isOwnerActive]);

  // Auto-start listening when panel opens
  useEffect(() => {
    if (!isOwnerActive || !hasLoadedSettings || hasAutoStartedRef.current) return;
    hasAutoStartedRef.current = true;
    void startListening();
  }, [isOwnerActive, hasLoadedSettings, startListening]);

  // Queue complete sentences as text streams in
  useEffect(() => {
    if (!isOwnerActive || !streamingText || !isAIStreaming) return;
    const newChunk = streamingText.slice(streamingSpokenRef.current);
    if (!newChunk) return;
    pendingTextRef.current += newChunk;
    streamingSpokenRef.current = streamingText.length;

    const sentenceRe = /[^.!?\n]+[.!?\n]+(?=\s|$)/g;
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    while ((match = sentenceRe.exec(pendingTextRef.current)) !== null) {
      queueSentence(match[0].trim());
      lastIndex = sentenceRe.lastIndex;
    }
    pendingTextRef.current = pendingTextRef.current.slice(lastIndex);
  }, [streamingText, isAIStreaming, isOwnerActive, queueSentence]);

  // When stream ends, speak any buffered tail
  useEffect(() => {
    if (isAIStreaming) return;
    if (pendingTextRef.current.trim()) {
      queueSentence(pendingTextRef.current.trim());
      pendingTextRef.current = '';
    }
    streamingSpokenRef.current = 0;
  }, [isAIStreaming, queueSentence]);

  // Fallback: speak full message when voice mode was activated after streaming ended
  useEffect(() => {
    if (!isOwnerActive || !latestAssistantMessage || isAIStreaming) return;
    if (isListening || isProcessing) return;
    if (spokenMessageIdsRef.current.has(latestAssistantMessage.id)) return;
    if (!latestAssistantMessage.text.trim()) return;
    if (streamingSpokenRef.current > 0) return;

    spokenMessageIdsRef.current.add(latestAssistantMessage.id);
    void speak(latestAssistantMessage.text);
  }, [latestAssistantMessage, isAIStreaming, isOwnerActive, isListening, isProcessing, speak]);

  const handleClose = useCallback(() => {
    disable();
    onClose?.();
  }, [disable, onClose]);

  const handleMicClick = useCallback(() => {
    if (isSpeaking) {
      bargeIn();
      return;
    }
    if (isListening) {
      stopListening();
      return;
    }
    if (!isProcessing) {
      void startListening();
    }
  }, [isSpeaking, isListening, isProcessing, bargeIn, stopListening, startListening]);

  if (!isOwnerActive) return null;

  const statusText =
    voiceState === 'listening'
      ? 'Listening...'
      : voiceState === 'processing'
        ? 'Transcribing...'
        : voiceState === 'waiting'
          ? 'Waiting for response...'
          : voiceState === 'speaking'
            ? isSpeaking
              ? interactionMode === 'barge-in'
                ? 'Speaking — interrupt anytime'
                : 'Speaking...'
              : 'Preparing audio...'
            : interactionMode === 'barge-in'
              ? 'Ready — speak anytime'
              : 'Tap the mic to speak';

  const micColor =
    isListening
      ? 'bg-red-500 text-white hover:bg-red-500/90'
      : isSpeaking
        ? 'bg-blue-500 text-white hover:bg-blue-500/90'
        : 'bg-primary text-primary-foreground hover:bg-primary/90';

  return (
    <div
      data-voice-owner={owner}
      className={cn(
        'flex flex-col gap-2 px-3 pt-2 pb-1 border-b border-border/50 bg-muted/30',
        className
      )}
    >
      <div className="flex items-center gap-3">
        {/* Mic / status button */}
        <Button
          type="button"
          size="icon"
          onClick={handleMicClick}
          disabled={isProcessing || (voiceState === 'speaking' && !isSpeaking)}
          className={cn('h-8 w-8 shrink-0 rounded-full shadow-sm transition-colors', micColor)}
        >
          {isProcessing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : isSpeaking ? (
            <Volume2 className="h-4 w-4" />
          ) : isListening ? (
            <Mic className="h-4 w-4" />
          ) : (
            <MicOff className="h-4 w-4" />
          )}
          <span className="sr-only">Voice control</span>
        </Button>

        {/* Status / transcript */}
        <div className="min-w-0 flex-1">
          {currentTranscript ? (
            <p className="truncate text-sm italic text-muted-foreground">
              &ldquo;{currentTranscript}&rdquo;
            </p>
          ) : (
            <p className="truncate text-sm text-muted-foreground">{statusText}</p>
          )}
          {error && (
            <p className="truncate text-xs text-destructive">{error}</p>
          )}
        </div>

        {/* Settings + close */}
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => setShowSettings((s) => !s)}
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span className="sr-only">Voice settings</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={handleClose}
          >
            <X className="h-3.5 w-3.5" />
            <span className="sr-only">Exit voice mode</span>
          </Button>
        </div>
      </div>

      {showSettings && (
        <div className="pb-1">
          <VoiceModeSettings />
        </div>
      )}
    </div>
  );
}

export default VoiceCallPanel;
