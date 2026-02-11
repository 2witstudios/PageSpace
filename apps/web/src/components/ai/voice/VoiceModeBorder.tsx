'use client';

import React from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { useVoiceModeStore } from '@/stores/useVoiceModeStore';

interface VoiceModeBorderProps {
  className?: string;
}

export function VoiceModeBorder({ className }: VoiceModeBorderProps) {
  const isEnabled = useVoiceModeStore((state) => state.isEnabled);
  const voiceState = useVoiceModeStore((state) => state.voiceState);

  if (!isEnabled) {
    return null;
  }

  const intensity =
    voiceState === 'listening' ? 1 :
    voiceState === 'processing' ? 0.75 :
    voiceState === 'speaking' ? 0.95 :
    0.45;

  return (
    <div className={cn('pointer-events-none absolute inset-0 z-20', className)}>
      <motion.div
        className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-cyan-400/10 via-cyan-400 to-blue-500/10"
        animate={{
          opacity: [0.2, 0.5 * intensity, 0.2],
          scaleX: [0.95, 1, 0.95],
        }}
        transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute inset-y-0 right-0 w-[2px] bg-gradient-to-b from-blue-500/10 via-cyan-400 to-cyan-400/10"
        animate={{
          opacity: [0.15, 0.45 * intensity, 0.15],
          scaleY: [0.95, 1, 0.95],
        }}
        transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut', delay: 0.1 }}
      />
      <motion.div
        className="absolute inset-x-0 bottom-0 h-[2px] bg-gradient-to-r from-blue-500/10 via-cyan-400 to-cyan-400/10"
        animate={{
          opacity: [0.2, 0.48 * intensity, 0.2],
          scaleX: [0.95, 1, 0.95],
        }}
        transition={{ duration: 1.45, repeat: Infinity, ease: 'easeInOut', delay: 0.2 }}
      />
      <motion.div
        className="absolute inset-y-0 left-0 w-[2px] bg-gradient-to-b from-cyan-400/10 via-blue-500 to-cyan-400/10"
        animate={{
          opacity: [0.15, 0.45 * intensity, 0.15],
          scaleY: [0.95, 1, 0.95],
        }}
        transition={{ duration: 1.25, repeat: Infinity, ease: 'easeInOut', delay: 0.15 }}
      />
    </div>
  );
}

export default VoiceModeBorder;
