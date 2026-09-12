"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { ComposedLine } from "@pagespace/lib/home-signals/composer";
import { cn } from "@/lib/utils";

export interface HomeStripProps {
  line: ComposedLine;
  className?: string;
}

/**
 * Once a conversation has started, the Home line collapses into this 32px
 * strip under the pane header instead of disappearing — the facts stay
 * reachable without competing with the conversation. "Show" expands it back
 * to the full line inline, without moving the composer.
 */
export function HomeStrip({ line, className }: HomeStripProps) {
  const [expanded, setExpanded] = useState(false);
  if (!line.lead) return null; // nothing to show on a quiet day

  const facts = [line.lead, ...line.rest];

  return (
    <div className={cn("border-b border-[var(--separator)] px-4", className)}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 py-2 text-left text-xs text-muted-foreground hover:text-foreground transition-colors",
          !expanded && "h-8",
        )}
      >
        <span className={cn("flex-1", expanded ? "whitespace-normal" : "truncate")}>
          {facts.join(" · ")}
        </span>
        {expanded ? <ChevronUp className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
      </button>
    </div>
  );
}
