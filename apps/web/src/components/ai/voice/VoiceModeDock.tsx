'use client';

import React, { useEffect, useCallback, useRef } from 'react';
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

export interface VoiceModeDockProps {
  owner: VoiceModeOwner;
  onSend: (text: string) => void;
  aiResponse?: VoiceResponse | null;
  isAIStreaming?: boolean;
  showSettings?: boolean;
  onToggleSettings?: () => void;
  onClose?: () => void;
  className?: string;
}

export function VoiceModeDock({
  owner,
  onSend,
  aiResponse,
  isAIStreaming = false,
  showSettings = false,
  onToggleSettings,
  onClose,
  className,
}: VoiceModeDockProps) {
  const hasStartedOnActivateRef = useRef(false);
  const spokenResponseIdsRef = useRef<Set<string>>(new Set());
  const activeOwner = useVoiceModeStore((state) => state.owner);

  const {
    isEnabled,
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
    bargeIn,
    interactionMode,
  } = useVoiceMode({
    onSend: (text) => {
      onSend(text);
    },
  });

  const isOwnerSessionActive = isEnabled && activeOwner === owner;

  useEffect(() => {
    if (isOwnerSessionActive) return;
    hasStartedOnActivateRef.current = false;
    spokenResponseIdsRef.current.clear();
  }, [isOwnerSessionActive]);

  // Auto-start capture when dock mounts for this active owner.
  useEffect(() => {
    if (!isOwnerSessionActive || !hasLoadedSettings || hasStartedOnActivateRef.current) return;
    hasStartedOnActivateRef.current = true;
    void startListening();
  }, [isOwnerSessionActive, hasLoadedSettings, startListening]);

  // Ensure this session only speaks each assistant message once.
  useEffect(() => {
    if (!isOwnerSessionActive || !aiResponse || isAIStreaming || isListening || isProcessing) return;
    if (spokenResponseIdsRef.current.has(aiResponse.id)) return;
    if (!aiResponse.text.trim()) return;

    spokenResponseIdsRef.current.add(aiResponse.id);
    void speak(aiResponse.text);
  }, [aiResponse, isAIStreaming, isOwnerSessionActive, isListening, isProcessing, speak]);

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

  if (!isOwnerSessionActive) {
    return null;
  }

  const statusText =
    voiceState === 'listening'
      ? 'Listening...'
      : voiceState === 'processing'
        ? 'Processing...'
        : voiceState === 'speaking'
          ? 'Speaking...'
          : voiceState === 'waiting'
            ? 'Waiting for response...'
            : interactionMode === 'barge-in'
              ? 'Speak anytime to interrupt'
              : 'Tap the mic to speak';

  return (
    <div
      data-voice-owner={owner}
      className={cn(
        'flex flex-col gap-3 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]',
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Voice mode</p>
          <p className="truncate text-sm font-medium text-foreground">{statusText}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onToggleSettings}
          >
            <Settings2 className="h-4 w-4" />
            <span className="sr-only">Voice settings</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleClose}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Exit voice mode</span>
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button
          type="button"
          size="icon"
          onClick={handleMicClick}
          disabled={isProcessing}
          className={cn(
            'h-11 w-11 rounded-full shadow-sm',
            isListening
              ? 'bg-red-500 text-white hover:bg-red-500/90'
              : isSpeaking
                ? 'bg-blue-500 text-white hover:bg-blue-500/90'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
          )}
        >
          {isProcessing ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : isSpeaking ? (
            <Volume2 className="h-5 w-5" />
          ) : isListening ? (
            <Mic className="h-5 w-5" />
          ) : (
            <MicOff className="h-5 w-5" />
          )}
          <span className="sr-only">Voice control</span>
        </Button>

        <div className="min-w-0 flex-1">
          {currentTranscript ? (
            <p className="line-clamp-2 text-sm italic text-muted-foreground">
              &ldquo;{currentTranscript}&rdquo;
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {interactionMode === 'barge-in'
                ? 'Barge-in is on. Speak while AI is talking to interrupt.'
                : 'Tap to start and stop recording.'}
            </p>
          )}
        </div>
      </div>

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      {showSettings && (
        <VoiceModeSettings />
      )}
    </div>
  );
}

export default VoiceModeDock;
