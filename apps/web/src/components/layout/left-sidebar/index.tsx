"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Lock, Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/useAuth";
import { getPermissionErrorMessage, canManageDrive } from "@/hooks/usePermissions";
import { useDriveStore } from "@/hooks/useDrive";
import { useUIStore } from "@/stores/useUIStore";

import DashboardSidebar from "./DashboardSidebar";
import PageTree from "./page-tree/PageTree";
import SidebarShell from "./SidebarShell";

export interface SidebarProps {
  className?: string;
  variant?: "desktop" | "overlay";
}

export default function Sidebar({ className }: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const params = useParams();
  const { driveId: driveIdParams } = params;
  const { user } = useAuth();

  const drives = useDriveStore((state) => state.drives);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);
  const openQuickCreate = useUIStore((state) => state.openQuickCreate);
  const driveId = Array.isArray(driveIdParams) ? driveIdParams[0] : driveIdParams;

  const drive = drives.find((d) => d.id === driveId);
  const canManage = canManageDrive(drive);

  useEffect(() => {
    if (user?.id) {
      fetchDrives();
    }
  }, [user?.id, fetchDrives]);

  return (
    <SidebarShell className={className}>
        {/* Main content area */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {driveId ? (
            <>
              {/* Drive view: Search + PageTree */}
              <div className="px-3 flex items-center gap-2 mb-3 flex-shrink-0">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search pages..."
                    className="h-8 pl-8"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                  />
                </div>
                {canManage ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => openQuickCreate(null)}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                ) : (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled
                          className="h-8 w-8 shrink-0 cursor-not-allowed opacity-50"
                        >
                          <Lock className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{getPermissionErrorMessage("create")}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>

              <div className="flex-1 min-h-0 overflow-hidden pr-3">
                <PageTree driveId={driveId as string} searchQuery={searchQuery} />
              </div>
            </>
          ) : (
            /* Dashboard view: Pulse, Favorites, Recents */
            <div className="px-3 flex-1 flex flex-col min-h-0">
              <DashboardSidebar />
            </div>
          )}
        </div>

    </SidebarShell>
  );
}
