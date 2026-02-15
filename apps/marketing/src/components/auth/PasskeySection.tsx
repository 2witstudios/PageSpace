"use client";

import { Fingerprint } from "lucide-react";
import { motion } from "motion/react";

interface PasskeySectionProps {
  delay?: number;
}

export function PasskeySection({ delay = 0.3 }: PasskeySectionProps) {
  return (
    <motion.div
      initial={{ y: 16, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5, delay, ease: [0.25, 0.46, 0.45, 0.94] }}
      className="flex flex-col items-center gap-2"
    >
      <button className="liquid-glass-thin group flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-border/50 px-6 text-sm font-medium text-foreground transition-all duration-200 hover:border-blue-500/30 hover:shadow-md active:scale-[0.98] cursor-pointer">
        <Fingerprint className="h-5 w-5 text-blue-500 transition-transform duration-200 group-hover:scale-110" />
        <span>Continue with passkey</span>
      </button>
      <button className="text-xs text-muted-foreground hover:text-blue-500 transition-colors cursor-pointer">
        Or use a magic link
      </button>
    </motion.div>
  );
}
