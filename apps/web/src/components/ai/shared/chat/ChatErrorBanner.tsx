'use client';

import React from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';
import { getAIErrorMessage, isOutOfCreditsError } from '@/lib/ai/shared/error-messages';
import { BuyCreditsButton } from '@/components/billing/BuyCreditsButton';

export interface ChatErrorBannerProps {
  /** The AI SDK chat error, if any. */
  error?: Error | null;
  /** Whether the banner should be shown (parent dismiss state). Defaults to true. */
  show?: boolean;
  /** Callback to dismiss the error. When omitted, no dismiss button is rendered. */
  onClearError?: () => void;
  /** Optional container class override. */
  className?: string;
}

/**
 * ChatErrorBanner - the single error banner shared by every AI-chat surface
 * (AI Chat page, Global Assistant, sidebar assistant, and the agent input area).
 *
 * It translates the raw chat error — which for credit-gate denials is the raw JSON
 * body, e.g. `{"error":"out_of_credits",...}` — into friendly copy via
 * `getAIErrorMessage()`, and surfaces a "Buy credits" call to action when the user is
 * out of prepaid credits. Never render `error.message` directly anywhere else.
 */
export function ChatErrorBanner({
  error,
  show = true,
  onClearError,
  className,
}: ChatErrorBannerProps) {
  const shouldReduceMotion = useReducedMotion();

  const visible = Boolean(error) && show;

  return (
    <AnimatePresence>
      {visible && error && (
        <motion.div
          data-testid="chat-error-banner"
          initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
          transition={{ duration: 0.2 }}
          className={cn(
            'mb-3 p-3 rounded-xl bg-destructive/10 border border-destructive/20 flex flex-col gap-2',
            className
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-destructive flex-1">{getAIErrorMessage(error.message)}</p>
            {onClearError && (
              <button
                type="button"
                onClick={onClearError}
                className="text-sm text-destructive/70 hover:text-destructive underline underline-offset-2 ml-3 shrink-0"
              >
                Dismiss
              </button>
            )}
          </div>
          {isOutOfCreditsError(error.message) && (
            <BuyCreditsButton variant="default" size="sm" className="self-start" />
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default ChatErrorBanner;
