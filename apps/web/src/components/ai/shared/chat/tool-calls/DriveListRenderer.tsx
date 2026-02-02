'use client';

import React, { memo } from 'react';
import { useRouter } from 'next/navigation';
import { HardDrive, ExternalLink, Users, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DriveInfo {
  id: string;
  name: string;
  slug: string;
  description?: string;
  isPersonal?: boolean;
  memberCount?: number;
}

interface DriveListRendererProps {
  /** List of drives */
  drives: DriveInfo[];
  /** Title override */
  title?: string;
  /** Maximum height before scrolling */
  maxHeight?: number;
  /** Additional CSS class */
  className?: string;
}

/**
 * DriveListRenderer - Displays a clean list of workspaces/drives
 *
 * Features:
 * - Click to navigate to drive
 * - Shows personal vs shared indicators
 * - Member count display
 * - Clean, minimal design
 */
export const DriveListRenderer: React.FC<DriveListRendererProps> = memo(function DriveListRenderer({
  drives,
  title = 'Workspaces',
  maxHeight = 300,
  className
}) {
  const router = useRouter();

  const handleNavigate = (driveId: string) => {
    router.push(`/dashboard/${driveId}`);
  };

  return (
    <div className={cn("rounded-lg border bg-card overflow-hidden my-2 shadow-sm", className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{title}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {drives.length} {drives.length === 1 ? 'workspace' : 'workspaces'}
        </span>
      </div>

      {/* Drive list */}
      <div
        className="bg-background overflow-auto divide-y divide-border"
        style={{ maxHeight: `${maxHeight}px` }}
      >
        {drives.length > 0 ? (
          drives.map((drive) => (
            <button
              key={drive.id}
              type="button"
              onClick={() => handleNavigate(drive.id)}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 text-left",
                "hover:bg-muted/50 transition-colors group"
              )}
            >
              {/* Drive icon */}
              <div className={cn(
                "flex items-center justify-center w-8 h-8 rounded-md shrink-0",
                drive.isPersonal ? "bg-primary/10" : "bg-blue-500/10"
              )}>
                {drive.isPersonal ? (
                  <Lock className="h-4 w-4 text-primary" />
                ) : (
                  <HardDrive className="h-4 w-4 text-blue-500" />
                )}
              </div>

              {/* Drive info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">
                    {drive.name}
                  </span>
                  {drive.isPersonal && (
                    <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      Personal
                    </span>
                  )}
                </div>
                {drive.description && (
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {drive.description}
                  </p>
                )}
              </div>

              {/* Member count & navigate */}
              <div className="flex items-center gap-2 shrink-0">
                {drive.memberCount !== undefined && drive.memberCount > 1 && (
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Users className="h-3 w-3" />
                    <span>{drive.memberCount}</span>
                  </div>
                )}
                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </button>
          ))
        ) : (
          <div className="text-sm text-muted-foreground text-center py-4">
            No workspaces found
          </div>
        )}
      </div>
    </div>
  );
});
