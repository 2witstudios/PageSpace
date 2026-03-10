/**
 * useChatError - Shared hook for managing chat error state
 *
 * Consolidates error state management with visibility toggle.
 * Used by GlobalAssistantView, SidebarChatTab, and AiChatView.
 */

import { useState, useEffect } from 'react';

export interface UseChatErrorOptions {
  error: Error | undefined;
}

export interface UseChatErrorReturn {
  showError: boolean;
  setShowError: (show: boolean) => void;
  handleClearError: () => void;
}

export function useChatError({ error }: UseChatErrorOptions): UseChatErrorReturn {
  const [showError, setShowError] = useState(true);

  // Reset error visibility when new error occurs
  useEffect(() => {
    if (error) {
      setShowError(true);
    }
  }, [error]);

  const handleClearError = () => {
    setShowError(false);
  };

  return {
    showError,
    setShowError,
    handleClearError,
  };
}
