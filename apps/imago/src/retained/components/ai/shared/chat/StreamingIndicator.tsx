/**
 * StreamingIndicator - Shows "Thinking..." state during AI response generation
 * Used by both Agent engine and Global Assistant engine
 */

import React from 'react';
import { Loader2 } from 'lucide-react';
import { ImagoOrb } from '@/ui/metal/imago-orb/imago-orb';
import { useInImagoThread } from '@/ui/metal/imago-thread';

interface StreamingIndicatorProps {
  /** Custom message to show instead of "Thinking..." */
  message?: string;
  /** Optional className for styling */
  className?: string;
}

/**
 * Streaming indicator shown while AI is generating a response
 */
export const StreamingIndicator: React.FC<StreamingIndicatorProps> = ({
  message = 'Thinking...',
  className,
}) => {
  const imago = useInImagoThread();
  return (
    <div
      data-testid="streaming-indicator"
      className={`mb-4 mr-8 ${className || ''}`}
      style={{ contain: 'layout style paint' }}
    >
      <div className="flex items-center space-x-2 text-gray-500">
        {/* Imago thinks as its orb; any other agent keeps the spinner (Imago maintained edit). */}
        {imago ? <ImagoOrb size="glyph" live /> : <Loader2 className="h-4 w-4 animate-spin" style={{ willChange: 'transform' }} />}
        <span>{message}</span>
      </div>
    </div>
  );
};
