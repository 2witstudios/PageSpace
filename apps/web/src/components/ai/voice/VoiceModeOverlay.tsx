'use client';

import React, { useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Mic, MicOff, Volume2, Loader2, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useVoiceMode } from '@/hooks/useVoiceMode';
import { VoiceModeSettings } from './VoiceModeSettings';

export interface VoiceModeOverlayProps {
  /** Called when voice mode is disabled/closed */
  onClose?: () => void;
  /** Called when a transcript should be sent as a message */
  onSend: (text: string) => void;
  /** Called when AI responds (for TTS playback) */
  aiResponse?: string | null;
  /** Whether AI is currently streaming/responding */
  isAIStreaming?: boolean;
  /** Whether to show settings panel */
  showSettings?: boolean;
  /** Toggle settings panel */
  onToggleSettings?: () => void;
}

/**
 * VoiceModeOverlay - Full-screen overlay for hands-free voice interaction.
 *
 * Features:
 * - Visual feedback for listening/processing/speaking states
 * - Tap-to-speak mode: Tap the mic to start/stop recording
 * - Barge-in mode: Automatically listens after AI speaks
 * - Settings panel for voice and interaction mode configuration
 */
export function VoiceModeOverlay({
  onClose,
  onSend,
  aiResponse,
  isAIStreaming = false,
  showSettings = false,
  onToggleSettings,
}: VoiceModeOverlayProps) {
  const {
    isEnabled,
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
    onError: (err) => {
      console.error('Voice mode error:', err);
    },
  });

  // Handle AI response for TTS
  useEffect(() => {
    if (aiResponse && !isAIStreaming && isEnabled && !isListening && !isProcessing) {
      speak(aiResponse);
    }
  }, [aiResponse, isAIStreaming, isEnabled, isListening, isProcessing, speak]);

  // Handle close
  const handleClose = useCallback(() => {
    disable();
    onClose?.();
  }, [disable, onClose]);

  // Handle mic button click
  const handleMicClick = useCallback(() => {
    if (isSpeaking) {
      // Barge in - stop TTS and start listening
      bargeIn();
    } else if (isListening) {
      // Stop listening
      stopListening();
    } else if (!isProcessing) {
      // Start listening
      startListening();
    }
  }, [isSpeaking, isListening, isProcessing, bargeIn, stopListening, startListening]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      } else if (e.key === ' ' && e.target === document.body) {
        e.preventDefault();
        handleMicClick();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClose, handleMicClick]);

  if (!isEnabled) return null;

  // Determine status text
  const getStatusText = () => {
    switch (voiceState) {
      case 'listening':
        return 'Listening...';
      case 'processing':
        return 'Processing...';
      case 'speaking':
        return 'Speaking...';
      case 'waiting':
        return 'Waiting for response...';
      case 'paused':
        return 'Paused';
      default:
        return interactionMode === 'tap-to-speak'
          ? 'Tap the microphone to speak'
          : 'Start speaking...';
    }
  };

  // Determine mic icon state
  const getMicIcon = () => {
    if (isProcessing) {
      return <Loader2 className="h-12 w-12 animate-spin" />;
    }
    if (isSpeaking) {
      return <Volume2 className="h-12 w-12" />;
    }
    if (isListening) {
      return <Mic className="h-12 w-12" />;
    }
    return <MicOff className="h-12 w-12" />;
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/95 backdrop-blur-sm"
      >
        {/* Close button */}
        <Button
          variant="ghost"
          size="icon"
          onClick={handleClose}
          className="absolute top-4 right-4 h-10 w-10"
        >
          <X className="h-6 w-6" />
          <span className="sr-only">Close voice mode</span>
        </Button>

        {/* Settings button */}
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleSettings}
          className={cn(
            'absolute top-4 left-4 h-10 w-10',
            showSettings && 'bg-accent'
          )}
        >
          <Settings2 className="h-6 w-6" />
          <span className="sr-only">Voice settings</span>
        </Button>

        {/* Settings panel */}
        <AnimatePresence>
          {showSettings && (
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="absolute left-4 top-16 w-80"
            >
              <VoiceModeSettings />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Main content */}
        <div className="flex flex-col items-center gap-8 max-w-lg px-4">
          {/* Status text */}
          <motion.p
            key={voiceState}
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-xl font-medium text-foreground"
          >
            {getStatusText()}
          </motion.p>

          {/* Mic button with visual feedback */}
          <motion.button
            onClick={handleMicClick}
            disabled={isProcessing}
            className={cn(
              'relative flex items-center justify-center w-32 h-32 rounded-full transition-all',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              isListening
                ? 'bg-red-500 text-white'
                : isSpeaking
                  ? 'bg-blue-500 text-white'
                  : isProcessing
                    ? 'bg-muted text-muted-foreground cursor-wait'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'
            )}
            whileTap={{ scale: 0.95 }}
          >
            {/* Pulsing ring animation when listening */}
            {isListening && (
              <>
                <motion.span
                  className="absolute inset-0 rounded-full bg-red-500"
                  animate={{
                    scale: [1, 1.2, 1],
                    opacity: [0.5, 0, 0.5],
                  }}
                  transition={{
                    duration: 1.5,
                    repeat: Infinity,
                    ease: 'easeInOut',
                  }}
                />
                <motion.span
                  className="absolute inset-0 rounded-full bg-red-500"
                  animate={{
                    scale: [1, 1.4, 1],
                    opacity: [0.3, 0, 0.3],
                  }}
                  transition={{
                    duration: 1.5,
                    repeat: Infinity,
                    ease: 'easeInOut',
                    delay: 0.5,
                  }}
                />
              </>
            )}

            {/* Speaking wave animation */}
            {isSpeaking && (
              <motion.span
                className="absolute inset-0 rounded-full bg-blue-500"
                animate={{
                  scale: [1, 1.1, 1],
                }}
                transition={{
                  duration: 0.5,
                  repeat: Infinity,
                  ease: 'easeInOut',
                }}
              />
            )}

            <span className="relative z-10">{getMicIcon()}</span>
          </motion.button>

          {/* Current transcript */}
          {currentTranscript && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="max-w-md text-center"
            >
              <p className="text-lg text-muted-foreground italic">
                &ldquo;{currentTranscript}&rdquo;
              </p>
            </motion.div>
          )}

          {/* Error message */}
          {error && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-sm text-destructive text-center"
            >
              {error}
            </motion.div>
          )}

          {/* Interaction mode hint */}
          <p className="text-sm text-muted-foreground text-center">
            {interactionMode === 'barge-in'
              ? 'Speak anytime to interrupt'
              : 'Press Space or tap to toggle'}
          </p>

          {/* Stop speaking hint */}
          {isSpeaking && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-sm text-muted-foreground"
            >
              Tap to interrupt
            </motion.p>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

export default VoiceModeOverlay;
