'use client';

import { ChevronRight, type LucideIcon } from 'lucide-react';

export type AgentSettingsCategory = 'behavior' | 'access' | 'tools' | 'integrations';

export interface AgentSettingsMenuItem {
  key: AgentSettingsCategory;
  title: string;
  description: string;
  icon: LucideIcon;
}

interface AgentSettingsMenuProps {
  items: AgentSettingsMenuItem[];
  selectCategory: (category: AgentSettingsCategory) => void;
}

export function AgentSettingsMenu({ items, selectCategory }: AgentSettingsMenuProps) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      {items.map(({ key, title, description, icon: Icon }, index) => (
        <button
          key={key}
          type="button"
          onClick={() => selectCategory(key)}
          className={`group flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-accent hover:text-accent-foreground ${index > 0 ? 'border-t' : ''}`}
        >
          <Icon className="h-5 w-5 shrink-0 text-muted-foreground group-hover:text-accent-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{title}</span>
            <span className="block truncate text-sm text-muted-foreground group-hover:text-accent-foreground">{description}</span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-accent-foreground" />
        </button>
      ))}
    </div>
  );
}
