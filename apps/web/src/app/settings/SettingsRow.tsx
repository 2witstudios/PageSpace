"use client";

import { ChevronRight, type LucideIcon } from "lucide-react";

export interface SettingsItem {
  title: string;
  description: string;
  icon: LucideIcon;
  href: string;
  available: boolean;
  desktopOnly?: boolean;
  mobileHidden?: boolean;
}

export function SettingsRow({ item, index }: { item: SettingsItem; index: number }) {
  const interactive = item.available;
  return (
    <div
      className={`
        group flex items-center gap-4 px-4 py-3 transition-colors
        ${interactive ? "hover:bg-accent hover:text-accent-foreground" : "opacity-50"}
        ${index > 0 ? "border-t" : ""}
      `}
    >
      <div className="flex-shrink-0">
        <item.icon
          className={`h-5 w-5 text-muted-foreground ${interactive ? "group-hover:text-accent-foreground" : ""}`}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium">{item.title}</div>
        <div
          className={`text-sm text-muted-foreground truncate ${interactive ? "group-hover:text-accent-foreground" : ""}`}
        >
          {item.description}
        </div>
      </div>
      <div className="flex-shrink-0">
        {!interactive ? (
          <span className="text-xs text-muted-foreground">
            Coming Soon
          </span>
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-accent-foreground" />
        )}
      </div>
    </div>
  );
}
