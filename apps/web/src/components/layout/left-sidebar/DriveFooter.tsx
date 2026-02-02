"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Activity,
  CheckSquare,
  ChevronDown,
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
import { useLayoutStore } from "@/stores/useLayoutStore";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { cn } from "@/lib/utils";

interface DriveFooterProps {
  canManage: boolean;
}

export default function DriveFooter({ canManage }: DriveFooterProps) {
  const params = useParams();
  const driveFooterCollapsed = useLayoutStore((state) => state.driveFooterCollapsed);
  const setDriveFooterCollapsed = useLayoutStore((state) => state.setDriveFooterCollapsed);
  const isSheetBreakpoint = useBreakpoint("(max-width: 1023px)");
  const setLeftSheetOpen = useLayoutStore((state) => state.setLeftSheetOpen);

  const { driveId: driveIdParams } = params;
  const driveId = Array.isArray(driveIdParams) ? driveIdParams[0] : driveIdParams;

  if (!driveId) return null;

  const handleLinkClick = () => {
    if (isSheetBreakpoint) {
      setLeftSheetOpen(false);
    }
  };

  const actions = [
    {
      icon: Activity,
      label: "Activity",
      href: `/dashboard/${driveId}/activity`,
      show: true,
    },
    {
      icon: CheckSquare,
      label: "Tasks",
      href: `/dashboard/${driveId}/tasks`,
      show: true,
    },
    {
      icon: Users,
      label: "Members",
      href: `/dashboard/${driveId}/members`,
      show: canManage,
    },
    {
      icon: Settings,
      label: "Settings",
      href: `/dashboard/${driveId}/settings`,
      show: canManage,
    },
    {
      icon: Trash2,
      label: "Trash",
      href: `/dashboard/${driveId}/trash`,
      show: true,
    },
  ].filter((action) => action.show);

  return (
    <Collapsible
      open={!driveFooterCollapsed}
      onOpenChange={(open) => setDriveFooterCollapsed(!open)}
      className="border-t border-[var(--separator)]"
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-between px-3 py-2 h-auto font-normal text-muted-foreground hover:text-foreground"
        >
          <span className="text-xs font-medium">Drive Actions</span>
          <ChevronDown
            className={cn(
              "h-4 w-4 transition-transform duration-200",
              !driveFooterCollapsed && "rotate-180"
            )}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-1 pb-2">
        <div className="space-y-0.5">
          {actions.map((action) => (
            <Link
              key={action.label}
              href={action.href}
              onClick={handleLinkClick}
              className={cn(
                "flex items-center gap-2.5 py-1.5 px-2 rounded-md text-sm transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
                "text-muted-foreground"
              )}
            >
              <action.icon className="h-4 w-4" />
              {action.label}
            </Link>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
