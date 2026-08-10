"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  Activity,
  GitCompare,
  ListTodo,
  Server,
  Settings,
  Sparkles,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import FleetTree from "./FleetTree";

const NAV = [
  { href: "/", label: "Assistant", icon: Sparkles },
  { href: "/fleet", label: "Fleet", icon: Activity },
  { href: "/tasks", label: "Tasks", icon: ListTodo },
  { href: "/workspaces", label: "Workspaces", icon: Server },
  { href: "/diff", label: "Diff", icon: GitCompare },
  { href: "/workflows", label: "Workflows", icon: Workflow },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

/**
 * The left rail: identity, primary nav, then the fleet tree — the sidebar IS
 * the surface, exactly like DevelopmentSidebar (DESIGN.md §3).
 */
export default function LeftRail() {
  const pathname = usePathname() ?? "/";

  return (
    <aside className="hidden h-full w-72 shrink-0 flex-col border-r border-[var(--separator)] liquid-glass-regular md:flex">
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <Image src="/pagespace-mark.png" alt="" width={20} height={20} className="rounded-sm" />
        <span className="text-sm font-semibold tracking-tight">
          PageSpace <span className="text-primary">Dev</span>
        </span>
      </div>

      <nav className="space-y-0.5 px-2 py-2">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="mx-4 border-t border-[var(--sidebar-divider)]" />

      <div className="px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Fleet
      </div>
      <ScrollArea className="min-h-0 flex-1 px-2 pb-3">
        <FleetTree />
      </ScrollArea>
    </aside>
  );
}
