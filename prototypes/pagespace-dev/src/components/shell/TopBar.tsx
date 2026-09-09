"use client";

import { usePathname } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import ThemeToggle from "./ThemeToggle";
import { agentById } from "@/lib/mock/agents";
import { workspaceById } from "@/lib/mock/workspaces";

/** Human name for the current route, agent/workspace-aware. */
function locationLabel(pathname: string): string {
  if (pathname === "/") return "Assistant";
  const [, section, id] = pathname.split("/");
  switch (section) {
    case "fleet":
      return "Fleet";
    case "agents":
      return agentById(id)?.name ?? "Agent";
    case "workspaces":
      return id ? (workspaceById(id)?.name ?? "Workspace") : "Workspaces";
    case "tasks":
      return "Tasks";
    case "diff":
      return "Cross-fleet diff";
    case "workflows":
      return "Workflows";
    case "settings":
      return "Settings";
    default:
      return "PageSpace Dev";
  }
}

export default function TopBar({ onSpawn }: { onSpawn: () => void }) {
  const pathname = usePathname() ?? "/";

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--separator)] px-4">
      <h1 className="truncate text-sm font-semibold">{locationLabel(pathname)}</h1>
      <div className="flex-1" />
      <Button size="sm" onClick={onSpawn} className="gap-1.5">
        <Plus className="size-4" />
        Spawn
        <kbd className="ml-1 rounded-sm bg-primary-foreground/15 px-1 font-mono text-[10px] leading-4">
          ⌘K
        </kbd>
      </Button>
      <ThemeToggle />
    </header>
  );
}
