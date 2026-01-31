"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useSWRConfig } from "swr";
import {
  Activity,
  CheckSquare,
  HardDrive,
  Home,
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
import { useAuth } from "@/hooks/useAuth";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { getPermissionErrorMessage, canManageDrive } from "@/hooks/usePermissions";
import { useDriveStore } from "@/hooks/useDrive";
import { useLayoutStore } from "@/stores/useLayoutStore";

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
  const isSheetBreakpoint = useBreakpoint("(max-width: 1023px)");
  const setLeftSheetOpen = useLayoutStore(state => state.setLeftSheetOpen);

  // Use selective Zustand subscriptions to prevent unnecessary re-renders
  const drives = useDriveStore(state => state.drives);
  const fetchDrives = useDriveStore(state => state.fetchDrives);

  const driveId = Array.isArray(driveIdParams) ? driveIdParams[0] : driveIdParams;
  const { mutate } = useSWRConfig();

  const drive = drives.find((d) => d.id === driveId);
  const canManage = canManageDrive(drive);

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
        "flex h-full w-full flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-sidebar-foreground liquid-glass-regular rounded-tr-lg border border-[var(--separator)] shadow-[var(--shadow-elevated)] dark:shadow-none overflow-hidden",
        className,
      )}
    >
      <div className="flex h-full flex-col gap-3 px-4 py-4 sm:px-3">
        <Link
          href="/dashboard"
          onClick={() => isSheetBreakpoint && setLeftSheetOpen(false)}
          className="flex items-center gap-2 rounded-lg p-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Home className="h-4 w-4" />
          Dashboard
        </Link>

        <DriveSwitcher />

        <div className="flex-1 overflow-hidden py-2 flex flex-col">
          {driveId ? (
            <>
              <div className="mb-4 flex items-center gap-2 flex-shrink-0">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search pages..."
                    className="h-9 pl-9"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                  />
                </div>
                {canManage ? (
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

              <div className="flex-1 min-h-0">
                <PageTree driveId={driveId as string} searchQuery={searchQuery} />
              </div>
            </>
          ) : (
            <DriveList />
          )}
        </div>

        <div className="mt-auto space-y-1">
          {driveId && canManage && (
            <Link
              href={`/dashboard/${driveId}/members`}
              className="flex items-center gap-2 rounded-lg p-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <Users className="h-4 w-4" />
              Members
            </Link>
          )}
          {!driveId && (
            <Link
              href="/dashboard/storage"
              className="flex items-center gap-2 rounded-lg p-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <HardDrive className="h-4 w-4" />
              Storage
            </Link>
          )}
          <Link
            href={driveId ? `/dashboard/${driveId}/activity` : "/dashboard/activity"}
            className="flex items-center gap-2 rounded-lg p-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Activity className="h-4 w-4" />
            Activity
          </Link>
          <Link
            href={driveId ? `/dashboard/${driveId}/tasks` : "/dashboard/tasks"}
            className="flex items-center gap-2 rounded-lg p-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <CheckSquare className="h-4 w-4" />
            Tasks
          </Link>
          {driveId && canManage && (
            <Link
              href={`/dashboard/${driveId}/settings`}
              className="flex items-center gap-2 rounded-lg p-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <Settings className="h-4 w-4" />
              Drive Settings
            </Link>
          )}
          {!driveId && (
            <Link
              href="/settings"
              className="flex items-center gap-2 rounded-lg p-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <Settings className="h-4 w-4" />
              Settings
            </Link>
          )}
          <Link
            href={driveId ? `/dashboard/${driveId}/trash` : "/dashboard/trash"}
            className="flex items-center gap-2 rounded-lg p-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Trash2 className="h-4 w-4" />
            Trash
          </Link>
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
