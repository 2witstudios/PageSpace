"use client";

import type { ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";

export interface SettingsItem {
  title: string;
  description: string;
  icon: LucideIcon;
  href: string;
  available: boolean;
  desktopOnly?: boolean;
  mobileHidden?: boolean;
  /** Hidden inside the native (Capacitor) apps. */
  nativeHidden?: boolean;
  /** A page served by the marketing site (opened outside the native web view). */
  marketing?: boolean;
}

export interface SettingsRowProps {
  item: Pick<SettingsItem, "title" | "description" | "icon" | "available">;
  index: number;
  /** Shown before the chevron, e.g. a count to review. */
  badge?: ReactNode;
  /** False for a row that runs an action instead of opening a page. */
  chevron?: boolean;
  /** A destructive action (Leave): red, and it stays red on hover instead of taking the accent flip. */
  destructive?: boolean;
}

export function SettingsRow({ item, index, badge, chevron = true, destructive = false }: SettingsRowProps) {
  const interactive = item.available;
  // The accent flip pairs the hover background with accent-foreground text (WCAG AA); a destructive
  // row keeps its red text and takes a red-tinted hover instead.
  const flip = interactive && !destructive;
  return (
    <div
      className={`
        group flex items-center gap-4 px-4 py-3 text-left transition-colors
        ${!interactive ? "opacity-50" : destructive ? "text-destructive hover:bg-destructive/10" : "hover:bg-accent hover:text-accent-foreground"}
        ${index > 0 ? "border-t" : ""}
      `}
    >
      <div className="flex-shrink-0">
        <item.icon
          className={`h-5 w-5 ${destructive ? "text-destructive" : "text-muted-foreground"} ${flip ? "group-hover:text-accent-foreground" : ""}`}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium">{item.title}</div>
        <div
          className={`text-sm text-muted-foreground truncate ${flip ? "group-hover:text-accent-foreground" : ""}`}
        >
          {item.description}
        </div>
      </div>
      {badge ? <div className="flex-shrink-0">{badge}</div> : null}
      <div className="flex-shrink-0">
        {!interactive ? (
          <span className="text-xs text-muted-foreground">
            Coming Soon
          </span>
        ) : chevron ? (
          <ChevronRight className={`h-4 w-4 text-muted-foreground ${flip ? "group-hover:text-accent-foreground" : ""}`} />
        ) : null}
      </div>
    </div>
  );
}
