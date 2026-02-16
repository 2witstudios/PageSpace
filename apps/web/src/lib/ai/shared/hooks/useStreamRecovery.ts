import { useEffect, useRef } from 'react';

interface UseStreamRecoveryOptions {
  /** Current error from useChat */
  error: Error | undefined;
  /** Current status from useChat */
  status: 'ready' | 'submitted' | 'streaming' | 'error';
  /** clearError from useChat — resets error state before retry */
  clearError: () => void;
  /** handleRetry from useMessageActions — deletes stale msgs + regenerates with chatId */
  handleRetry: () => Promise<void>;
  /** Max auto-retry attempts before giving up (default: 2) */
  maxRetries?: number;
}

/** Returns true if the error looks like a network/connection failure (not an API error) */
const isNetworkError = (error: Error): boolean => {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('network') ||
    msg.includes('failed to fetch') ||
    msg.includes('err_network') ||
    msg.includes('aborted') ||
    msg.includes('connection') ||
    msg.includes('timeout') ||
    error.name === 'TypeError' // fetch throws TypeError on network failure
  );
};

/** Returns true if the error is an API/auth error that should NOT be auto-retried */
const isApiError = (error: Error): boolean => {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('401') ||
    msg.includes('unauthorized') ||
    msg.includes('403') ||
    msg.includes('429') ||
    msg.includes('402') ||
    msg.includes('rate') ||
    msg.includes('limit') ||
    msg.includes('chatid is required')
  );
};

export function useStreamRecovery({
  error,
  status,
  clearError,
  handleRetry,
  maxRetries = 2,
}: UseStreamRecoveryOptions) {
  const retryCountRef = useRef(0);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isRetryingRef = useRef(false);

  // Reset retry count when a stream succeeds (status goes to ready after streaming)
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const wasStreaming = prevStatusRef.current === 'streaming' || prevStatusRef.current === 'submitted';
    if (wasStreaming && status === 'ready') {
      retryCountRef.current = 0;
    }
    prevStatusRef.current = status;
  }, [status]);

  // Auto-retry on network errors
  useEffect(() => {
    if (!error || status !== 'error' || isRetryingRef.current) return;
    if (isApiError(error)) return;
    if (!isNetworkError(error)) return;
    if (retryCountRef.current >= maxRetries) return;

    retryCountRef.current++;
    const delay = 1000 * Math.pow(2, retryCountRef.current - 1); // 1s, 2s

    retryTimeoutRef.current = setTimeout(async () => {
      isRetryingRef.current = true;
      clearError();
      try {
        await handleRetry();
      } finally {
        isRetryingRef.current = false;
      }
    }, delay);

    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    };
  }, [error, status, clearError, handleRetry, maxRetries]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
    };
  }, []);

  return {
    /** Number of auto-retries attempted for the current error */
    retryCount: retryCountRef.current,
    /** Whether max retries have been exhausted */
    retriesExhausted: retryCountRef.current >= maxRetries,
  };
}
