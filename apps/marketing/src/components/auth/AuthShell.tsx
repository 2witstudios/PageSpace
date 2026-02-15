"use client";

import { motion } from "motion/react";
import { type ReactNode } from "react";
import { SiteNavbar } from "@/components/SiteNavbar";

interface AuthShellProps {
  children: ReactNode;
}

export function AuthShell({ children }: AuthShellProps) {
  return (
    <div className="relative flex min-h-screen flex-col bg-gradient-to-br from-blue-50 via-blue-100/60 to-blue-200/50 dark:from-neutral-950 dark:via-blue-950/30 dark:to-blue-950/50">
      {/* Floating orbs */}
      <FloatingOrbs />

      {/* Toolbar — exact prod TopBar classes */}
      <SiteNavbar />

      {/* Centered form */}
      <div className="relative z-10 flex flex-1 items-center justify-center px-8 py-12">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2 }}
          className="w-full max-w-[420px]"
        >
          {children}
        </motion.div>
      </div>
    </div>
  );
}

function FloatingOrbs() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <motion.div
        className="absolute -top-20 right-[30%] h-80 w-80 rounded-full bg-blue-400/15 blur-3xl dark:bg-blue-500/12"
        animate={{ x: [0, 30, -20, 0], y: [0, -20, 15, 0], scale: [1, 1.05, 0.95, 1] }}
        transition={{ duration: 20, ease: "easeInOut", repeat: Infinity }}
      />
      <motion.div
        className="absolute bottom-20 left-[5%] h-56 w-56 rounded-full bg-blue-400/12 blur-3xl dark:bg-blue-500/10"
        animate={{ x: [0, -25, 35, 0], y: [0, 25, -10, 0], scale: [1, 0.97, 1.03, 1] }}
        transition={{ duration: 25, ease: "easeInOut", repeat: Infinity }}
      />
      <motion.div
        className="absolute top-[40%] right-[15%] h-64 w-64 rounded-full bg-blue-400/12 blur-3xl dark:bg-blue-500/10"
        animate={{ x: [0, 20, 0], y: [0, 20, 0], scale: [1, 1.04, 1] }}
        transition={{ duration: 15, ease: "easeInOut", repeat: Infinity }}
      />
    </div>
  );
}
