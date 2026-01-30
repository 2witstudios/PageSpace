"use client";

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useOpenTabsStore } from '@/stores/useOpenTabsStore';
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { PageType } from '@pagespace/lib/client-safe';
import { cn } from '@/lib/utils';

interface RecentsDropdownProps {
  className?: string;
}

export default function RecentsDropdown({ className }: RecentsDropdownProps) {
  const router = useRouter();
  const tabs = useOpenTabsStore((state) => state.tabs);

  const handleNavigate = useCallback((driveId: string, pageId: string) => {
    router.push(`/dashboard/${driveId}/${pageId}`);
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
          tabs.map((tab) => (
            <DropdownMenuItem
              key={tab.id}
              onClick={() => handleNavigate(tab.driveId, tab.id)}
              className="cursor-pointer"
            >
              <PageTypeIcon
                type={tab.type as PageType}
                className="mr-2 h-4 w-4 flex-shrink-0"
              />
              <span className="truncate">{tab.title}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
