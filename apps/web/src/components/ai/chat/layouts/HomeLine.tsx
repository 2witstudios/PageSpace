"use client";

import { useReducedMotion, motion } from "motion/react";
import {
  AlertTriangle,
  AtSign,
  Bot,
  Calendar,
  CheckSquare,
  FileText,
  MessageSquare,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import type { ComposedLine, SignalIconName } from "@pagespace/lib/home-signals/composer";
import { cn } from "@/lib/utils";

// Keyed by SignalIconName (not a bare string) so a new icon NAME introduced
// in composer.ts's SIGNAL_ICON — the actual value domain ComposedLine.icon
// draws from — is a compile error here until a component is added, instead
// of silently rendering no icon at runtime.
const ICONS: Record<SignalIconName, LucideIcon> = {
  at: AtSign,
  "alert-triangle": AlertTriangle,
  calendar: Calendar,
  bot: Bot,
  "check-square": CheckSquare,
  "message-square": MessageSquare,
  "file-text": FileText,
  sparkles: Sparkles,
};

export interface HomeLineProps {
  line: ComposedLine;
  className?: string;
}

/**
 * The Home "signal line": a small greeting plus one line of text above the
 * composer. Deliberately minimal — one lead fact in normal weight, the rest
 * muted after middots, an icon naming the lead fact's kind (or none at all
 * on a quiet day). This replaces the generic WelcomeContent title/subtitle
 * in global-assistant mode only.
 */
export function HomeLine({ line, className }: HomeLineProps) {
  const shouldReduceMotion = useReducedMotion();
  const Icon = line.icon ? ICONS[line.icon] : null;

  const leadNode = line.leadHref && line.lead ? (
    <Link href={line.leadHref} className="text-foreground hover:underline underline-offset-2">
      {line.lead}
    </Link>
  ) : (
    <span className="text-foreground">{line.lead}</span>
  );

  return (
    <motion.div
      className={cn("flex flex-col items-center text-center gap-4 mb-6", className)}
      initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: shouldReduceMotion ? 0 : 0.3 }}
    >
      <h2 className="text-xl font-medium text-foreground tracking-tight">{line.greeting}</h2>
      <p className="flex items-center gap-2 text-sm leading-relaxed text-muted-foreground px-2">
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        <span>
          {line.lead && leadNode}
          {line.rest.map((fact) => (
            <span key={fact}> · {fact}</span>
          ))}
        </span>
      </p>
    </motion.div>
  );
}
