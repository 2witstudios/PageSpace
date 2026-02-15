"use client";

import { motion } from "motion/react";

interface AuthDividerProps {
  delay?: number;
}

export function AuthDivider({ delay = 0.25 }: AuthDividerProps) {
  return (
    <motion.div
      initial={{ y: 16, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5, delay, ease: [0.25, 0.46, 0.45, 0.94] }}
      className="flex items-center gap-4"
    >
      <div className="h-px flex-1 bg-gradient-to-r from-transparent via-border to-transparent" />
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-widest">
        or
      </span>
      <div className="h-px flex-1 bg-gradient-to-l from-transparent via-border to-transparent" />
    </motion.div>
  );
}
