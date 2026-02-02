"use client";

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Clock, File, LayoutDashboard, CheckSquare, Activity, Users, Settings, Trash2, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTabsStore, type Tab } from '@/stores/useTabsStore';
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { parseTabPath, getStaticTabMeta } from '@/lib/tabs/tab-title';
import { PageType } from '@pagespace/lib/client-safe';
import { cn } from '@/lib/utils';

// Map icon names to components
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  LayoutDashboard,
  CheckSquare,
  Activity,
  Users,
  Settings,
  Trash2,
  MessageSquare,
  File,
};

interface RecentsDropdownProps {
  className?: string;
}

// Helper to derive tab display info
function getTabDisplayInfo(tab: Tab) {
  const parsed = parseTabPath(tab.path);
  const meta = getStaticTabMeta(parsed);

  if (meta) {
    return { title: meta.title, iconName: meta.iconName };
  }

  // Fallback for page/drive types
  if (parsed.type === 'page') {
    return { title: 'Page', iconName: 'File' };
  }
  if (parsed.type === 'drive') {
    return { title: 'Drive', iconName: 'LayoutDashboard' };
  }

  return { title: tab.path, iconName: 'File' };
}

export default function RecentsDropdown({ className }: RecentsDropdownProps) {
  const router = useRouter();
  const tabs = useTabsStore((state) => state.tabs);

  const handleNavigate = useCallback((path: string) => {
    router.push(path);
  }, [router]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("relative", className)}
          aria-label="Recent pages"
        >
          <Clock className="h-5 w-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64" align="end" forceMount>
        <DropdownMenuLabel>Recent Pages</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {tabs.length === 0 ? (
          <div className="px-2 py-4 text-sm text-muted-foreground text-center">
            No recent pages
          </div>
        ) : (
          tabs.map((tab) => {
            const { title, iconName } = getTabDisplayInfo(tab);
            const IconComponent = ICON_MAP[iconName];

            return (
              <DropdownMenuItem
                key={tab.id}
                onClick={() => handleNavigate(tab.path)}
                className="cursor-pointer"
              >
                {IconComponent ? (
                  <IconComponent className="mr-2 h-4 w-4 flex-shrink-0" />
                ) : (
                  <PageTypeIcon
                    type={'DOCUMENT' as PageType}
                    className="mr-2 h-4 w-4 flex-shrink-0"
                  />
                )}
                <span className="truncate">{title}</span>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
