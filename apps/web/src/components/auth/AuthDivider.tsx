'use client';

import { motion } from 'motion/react';

interface AuthDividerProps {
  delay?: number;
}

export function AuthDivider({ delay = 0.4 }: AuthDividerProps) {
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
        <span className="bg-gradient-to-br from-blue-50 via-blue-100/60 to-blue-200/50 px-4 text-xs font-medium uppercase tracking-wider text-muted-foreground dark:from-gray-950 dark:via-blue-950/40 dark:to-gray-900">
          or
        </span>
      </div>
    </motion.div>
  );
}
