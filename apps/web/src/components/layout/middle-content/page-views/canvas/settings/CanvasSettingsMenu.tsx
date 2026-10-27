"use client";

import { ChevronRight, type LucideIcon } from 'lucide-react';

export interface CanvasSettingsCategory {
  key: string;
  title: string;
  description: string;
  icon: LucideIcon;
}

interface CanvasSettingsMenuProps {
  categories: CanvasSettingsCategory[];
  onSelect: (key: string) => void;
}

/**
 * Entry view for the canvas Settings tab — a list of category rows a user
 * clicks into, visually modeled on the Drive/User settings row list
 * (`@/app/settings/SettingsRow.tsx`). Not real routes (canvas pages don't
 * render through file-based sub-routes), so rows are `onClick`-driven rather
 * than `Link`s — the parent panel reflects the selection in the URL instead.
 */
export function CanvasSettingsMenu({ categories, onSelect }: CanvasSettingsMenuProps) {
  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      {categories.map((category, index) => (
        <button
          key={category.key}
          type="button"
          onClick={() => onSelect(category.key)}
          className={`
            group flex w-full items-center gap-4 px-4 py-3 text-left transition-colors
            hover:bg-accent hover:text-accent-foreground
            ${index > 0 ? 'border-t' : ''}
          `}
        >
          <div className="flex-shrink-0">
            <category.icon className="h-5 w-5 text-muted-foreground group-hover:text-accent-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium">{category.title}</div>
            <div className="text-sm text-muted-foreground truncate group-hover:text-accent-foreground">
              {category.description}
            </div>
          </div>
          <div className="flex-shrink-0">
            <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-accent-foreground" />
          </div>
        </button>
      ))}
    </div>
  );
}
