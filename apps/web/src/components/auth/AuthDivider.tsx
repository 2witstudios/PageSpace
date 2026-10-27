'use client';

import { motion } from 'motion/react';
import { isV3AuthEnabled } from '@/lib/imago/v3-auth-enabled';

interface AuthDividerProps {
  delay?: number;
}

export function AuthDivider({ delay = 0.4 }: AuthDividerProps) {
  if (isV3AuthEnabled()) {
    return (
      <div
        role="separator"
        className="my-5 flex items-center gap-3 text-xs uppercase tracking-[0.06em] text-[oklch(0.60_0.012_220)]"
      >
        <span className="h-px flex-1 bg-[oklch(0.90_0.005_230)]" />
        or
        <span className="h-px flex-1 bg-[oklch(0.90_0.005_230)]" />
      </div>
    );
  }
  return (
    <motion.div
      className="relative my-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay, duration: 0.4 }}
    >
      <div className="absolute inset-0 flex items-center">
        <div className="h-px w-full bg-gradient-to-r from-transparent via-gray-300 to-transparent dark:via-gray-600" />
      </div>
      <div className="relative flex justify-center">
        <span className="bg-gradient-to-br from-blue-50 via-blue-100/60 to-blue-200/50 px-4 text-xs font-medium uppercase tracking-wider text-muted-foreground dark:from-background dark:via-blue-950/40 dark:to-card">
          or
        </span>
      </div>
    </motion.div>
  );
}
