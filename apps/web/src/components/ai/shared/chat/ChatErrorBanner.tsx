'use client';

import React from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';
import type { AIErrorCause } from '@/lib/ai/shared/aiErrorCause';
import { BuyCreditsButton } from '@/components/billing/BuyCreditsButton';

export interface ChatErrorBannerProps {
  /** The typed error cause (epic leaf 6.5), or null when there's nothing to show. */
  cause?: AIErrorCause | null;
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
 * Renders `cause.message` directly — already friendly copy resolved by
 * `toErrorCause`/`parseLegacyErrorMessage` upstream (epic leaf 6.5) — and
 * surfaces a "Buy credits" call to action on `cause.code === 'out_of_credits'`.
 * Never render a raw `Error.message` anywhere in this component.
 */
export function ChatErrorBanner({
  cause,
  show = true,
  onClearError,
  className,
}: ChatErrorBannerProps) {
  const shouldReduceMotion = useReducedMotion();

  const visible = Boolean(cause) && show;

  return (
    <AnimatePresence>
      {visible && cause && (
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
            <p className="text-sm text-destructive flex-1">{cause.message}</p>
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
          {cause.code === 'out_of_credits' && (
            <BuyCreditsButton variant="default" size="sm" className="self-start" />
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default ChatErrorBanner;
