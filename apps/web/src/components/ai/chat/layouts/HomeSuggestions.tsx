"use client";

import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface HomeSuggestionsProps {
  suggestions: readonly string[];
  /** Seeds the composer with the clicked suggestion — does not send it. */
  onSelect: (prompt: string) => void;
  className?: string;
}

/**
 * Up to three plain-text suggestions under the Home line, each seeding the
 * composer on click rather than sending immediately. Deliberately no
 * borders/cards — text plus a small arrow, so it reads as a hint, not a
 * feature grid.
 */
export function HomeSuggestions({ suggestions, onSelect, className }: HomeSuggestionsProps) {
  if (suggestions.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-center justify-center gap-x-6 gap-y-2 px-4", className)}>
      {suggestions.map((prompt) => (
        <button
          key={prompt}
          type="button"
          onClick={() => onSelect(prompt)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors pointer-events-auto"
        >
          <ArrowRight className="h-3 w-3 shrink-0" aria-hidden />
          <span>{prompt}</span>
        </button>
      ))}
    </div>
  );
}
