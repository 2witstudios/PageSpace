'use client';

import { motion } from 'motion/react';

interface AuthShellProps {
  children: React.ReactNode;
}

export function AuthShell({ children }: AuthShellProps) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-blue-50 via-blue-100/60 to-blue-200/50 dark:from-gray-950 dark:via-blue-950/40 dark:to-gray-900">
      {/* Floating orbs */}
      <motion.div
        className="pointer-events-none absolute -top-24 -left-24 h-72 w-72 rounded-full bg-blue-300/30 blur-3xl dark:bg-blue-500/10"
        animate={{
          x: [0, 40, -20, 0],
          y: [0, -30, 20, 0],
        }}
        transition={{
          duration: 18,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />
      <motion.div
        className="pointer-events-none absolute top-1/3 -right-16 h-56 w-56 rounded-full bg-indigo-300/25 blur-3xl dark:bg-indigo-500/10"
        animate={{
          x: [0, -30, 15, 0],
          y: [0, 25, -35, 0],
        }}
        transition={{
          duration: 22,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />
      <motion.div
        className="pointer-events-none absolute -bottom-16 left-1/4 h-64 w-64 rounded-full bg-sky-300/20 blur-3xl dark:bg-sky-500/10"
        animate={{
          x: [0, 25, -35, 0],
          y: [0, -20, 30, 0],
        }}
        transition={{
          duration: 20,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />

      {/* Content */}
      <div className="relative z-10 w-full max-w-[420px] px-6 py-12">
        {children}
      </div>
    </div>
  );
}
