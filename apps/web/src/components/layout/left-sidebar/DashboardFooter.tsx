"use client";

import { type MouseEvent } from "react";
import Link from "next/link";
import {
  Activity,
  CheckSquare,
  ChevronDown,
  ExternalLink,
  Settings,
  Trash2,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useTabsStore } from "@/stores/useTabsStore";
import { shouldOpenInNewTab } from "@/lib/tabs/tab-navigation-utils";
import { cn } from "@/lib/utils";

const actions = [
  {
    icon: CheckSquare,
    label: "Tasks",
    href: "/dashboard/tasks",
  },
  {
    icon: Activity,
    label: "Activity",
    href: "/dashboard/activity",
  },
  {
    icon: Users,
    label: "Collaborators",
    href: "/dashboard/connections",
  },
  {
    icon: Settings,
    label: "Settings",
    href: "/settings",
  },
  {
    icon: Trash2,
    label: "Trash",
    href: "/dashboard/trash",
  },
];

export default function DashboardFooter() {
  const dashboardFooterCollapsed = useLayoutStore((state) => state.dashboardFooterCollapsed);
  const setDashboardFooterCollapsed = useLayoutStore((state) => state.setDashboardFooterCollapsed);
  const isSheetBreakpoint = useBreakpoint("(max-width: 1023px)");
  const setLeftSheetOpen = useLayoutStore((state) => state.setLeftSheetOpen);
  const createTab = useTabsStore((state) => state.createTab);

  const handleLinkClick = (e: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (shouldOpenInNewTab(e)) {
      e.preventDefault();
      createTab({ path: href, activate: false });
      return;
    }

    if (isSheetBreakpoint) {
      setLeftSheetOpen(false);
    }
  };

  const handleOpenInNewTab = (href: string) => {
    createTab({ path: href, activate: false });
  };

  return (
    <Collapsible
      open={!dashboardFooterCollapsed}
      onOpenChange={(open) => setDashboardFooterCollapsed(!open)}
      className="border-t border-[var(--separator)]"
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-between px-3 py-2 h-auto font-normal text-muted-foreground hover:text-foreground"
        >
          <span className="text-xs font-medium">User Actions</span>
          <ChevronDown
            className={cn(
              "h-4 w-4 transition-transform duration-200",
              !dashboardFooterCollapsed && "rotate-180"
            )}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-1 pb-2">
        <div className="space-y-0.5">
          {actions.map((action) => (
            <ContextMenu key={action.label}>
              <ContextMenuTrigger asChild>
                <Link
                  href={action.href}
                  onClick={(e) => handleLinkClick(e, action.href)}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      handleOpenInNewTab(action.href);
                    }
                  }}
                  className={cn(
                    "flex items-center gap-2.5 py-1.5 px-2 rounded-md text-sm transition-colors",
                    "hover:bg-accent hover:text-accent-foreground",
                    "text-muted-foreground"
                  )}
                >
                  <action.icon className="h-4 w-4" />
                  {action.label}
                </Link>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => handleOpenInNewTab(action.href)}>
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Open in new tab
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
