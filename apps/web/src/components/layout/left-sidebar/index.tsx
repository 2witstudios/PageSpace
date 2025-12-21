"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useSWRConfig } from "swr";
import {
  Activity,
  HardDrive,
  Lock,
  Plus,
  Search,
  Settings,
  Trash2,
  Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { getPermissionErrorMessage } from "@/hooks/use-permissions";
import { useDriveStore } from "@/hooks/useDrive";

import CreatePageDialog from "./CreatePageDialog";
import DriveList from "./DriveList";
import DriveSwitcher from "./workspace-selector";
import PageTree from "./page-tree/PageTree";

export interface SidebarProps {
  className?: string;
  variant?: "desktop" | "overlay";
}

export default function Sidebar({ className }: SidebarProps) {
  const [isCreatePageOpen, setCreatePageOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const params = useParams();
  const { driveId: driveIdParams } = params;
  const { user } = useAuth();

  // Use selective Zustand subscriptions to prevent unnecessary re-renders
  const drives = useDriveStore(state => state.drives);
  const fetchDrives = useDriveStore(state => state.fetchDrives);

  const driveId = Array.isArray(driveIdParams) ? driveIdParams[0] : driveIdParams;
  const { mutate } = useSWRConfig();

  const drive = drives.find((d) => d.id === driveId);
  const canCreatePages = drive?.isOwned || drive?.role === 'ADMIN' || false;

  useEffect(() => {
    if (driveId && user?.id) {
      fetchDrives();
    }
  }, [driveId, user?.id, fetchDrives]);

  const handlePageCreated = () => {
    if (driveId) {
      void mutate(`/api/drives/${driveId}/pages`);
    }
  };

  return (
    <aside
      className={cn(
        "flex h-full w-full flex-col text-sidebar-foreground liquid-glass-regular rounded-tr-lg border border-[var(--separator)] shadow-[var(--shadow-elevated)] dark:shadow-none overflow-hidden",
        className,
      )}
    >
      <div className="flex h-full flex-col gap-3 px-4 py-4 sm:px-3">
        <DriveSwitcher />

        <div className="flex-1 overflow-y-auto overflow-x-hidden py-2">
          {driveId ? (
            <>
              <div className="mb-4 flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search pages..."
                    className="h-9 pl-9"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                  />
                </div>
                {canCreatePages ? (
                  <Button variant="ghost" size="icon" onClick={() => setCreatePageOpen(true)}>
                    <Plus className="h-5 w-5" />
                  </Button>
                ) : (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled
                          className="cursor-not-allowed opacity-50"
                        >
                          <Lock className="h-5 w-5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{getPermissionErrorMessage("create")}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>

              <PageTree driveId={driveId as string} searchQuery={searchQuery} />
            </>
          ) : (
            <DriveList />
          )}
        </div>

        <div className="mt-auto space-y-1">
          {driveId && (drive?.isOwned || drive?.role) && (
            <>
              <Link
                href={`/dashboard/${driveId}/members`}
                className="flex items-center gap-2 rounded-lg p-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <Users className="h-4 w-4" />
                Members
              </Link>
              {(drive?.isOwned || drive?.role === 'ADMIN') && (
                <Link
                  href={`/dashboard/${driveId}/settings`}
                  className="flex items-center gap-2 rounded-lg p-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  <Settings className="h-4 w-4" />
                  Drive Settings
                </Link>
              )}
            </>
          )}
          <Link
            href={driveId ? `/dashboard/${driveId}/trash` : "/dashboard/trash"}
            className="flex items-center gap-2 rounded-lg p-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Trash2 className="h-4 w-4" />
            Trash
          </Link>
          <Link
            href={driveId ? `/dashboard/${driveId}/activity` : "/dashboard/activity"}
            className="flex items-center gap-2 rounded-lg p-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Activity className="h-4 w-4" />
            Activity
          </Link>
          {!driveId && (
            <>
              <Link
                href="/dashboard/storage"
                className="flex items-center gap-2 rounded-lg p-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <HardDrive className="h-4 w-4" />
                Storage
              </Link>
              <Link
                href="/settings"
                className="flex items-center gap-2 rounded-lg p-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <Settings className="h-4 w-4" />
                Settings
              </Link>
            </>
          )}
        </div>

        <CreatePageDialog
          parentId={null}
          isOpen={isCreatePageOpen}
          setIsOpen={setCreatePageOpen}
          onPageCreated={handlePageCreated}
          driveId={driveId as string}
        />
      </div>
    </aside>
  );
}
