/**
 * StreamingIndicator - Shows "Thinking..." state during AI response generation
 * Used by both Agent engine and Global Assistant engine
 */

import React from 'react';
import { Loader2 } from 'lucide-react';

interface StreamingIndicatorProps {
  /** Name of the assistant (e.g., "Assistant", "Global Assistant", agent name) */
  assistantName?: string;
  /** Custom message to show instead of "Thinking..." */
  message?: string;
  /** Optional className for styling */
  className?: string;
}

/**
 * Streaming indicator shown while AI is generating a response
 */
export const StreamingIndicator: React.FC<StreamingIndicatorProps> = ({
  assistantName = 'Assistant',
  message = 'Thinking...',
  className,
}) => {
  return (
    <div
      className={`mb-4 p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50 mr-8 ${className || ''}`}
      style={{ contain: 'layout style paint' }}
    >
      <div className="text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
        {assistantName}
      </div>
      <div className="flex items-center space-x-2 text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" style={{ willChange: 'transform' }} />
        <span>{message}</span>
      </div>
    </div>
  );
};

export default StreamingIndicator;
