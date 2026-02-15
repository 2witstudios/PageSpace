"use client";

import { motion } from "motion/react";
import { MockAppPreview } from "@/components/MockAppPreview";

interface AuthMockPreviewProps {
  variant: "sidebar" | "document" | "chat" | "canvas";
}

export function AuthMockPreview({ variant }: AuthMockPreviewProps) {
  return (
    <div className="relative flex items-center justify-center h-full w-full" style={{ perspective: "1200px" }}>
      {/* Blue radial glow behind the preview */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_50%,rgba(59,130,246,0.15),transparent_70%)]" />

      <motion.div
        initial={{ x: 60, rotateY: -8, opacity: 0 }}
        animate={{ x: 0, rotateY: -4, opacity: 1 }}
        transition={{ duration: 0.8, delay: 0.3, ease: [0.25, 0.46, 0.45, 0.94] }}
        className="relative w-full max-w-[640px]"
        style={{ transformStyle: "preserve-3d" }}
      >
        <div
          className="rounded-xl border border-border/40 bg-card shadow-2xl overflow-hidden"
          style={{ animation: "auth-preview-float 6s ease-in-out infinite" }}
        >
          {/* Browser chrome */}
          <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-2.5">
            <div className="flex gap-1.5">
              <div className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
              <div className="h-2.5 w-2.5 rounded-full bg-yellow-400/80" />
              <div className="h-2.5 w-2.5 rounded-full bg-green-400/80" />
            </div>
            <div className="flex-1 text-center">
              <div className="inline-flex items-center gap-2 rounded-md bg-muted px-3 py-0.5 text-[10px] text-muted-foreground">
                app.pagespace.ai
              </div>
            </div>
          </div>

          {/* App preview content — rendered large then scaled down for miniature effect */}
          <div className="h-[440px] overflow-hidden">
            <div
              className="origin-top-left"
              style={{
                width: "1100px",
                height: "750px",
                transform: "scale(0.58)",
              }}
            >
              <MockAppPreview variant={variant} />
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
