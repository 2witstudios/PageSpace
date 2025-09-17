'use client';

import PageTree from "./page-tree/PageTree";
import { Button } from "@/components/ui/button";
import { Trash2, Search, Plus, Users, Lock, Settings, HardDrive } from "lucide-react";
import { useState, useEffect } from "react";
import CreatePageDialog from "./CreatePageDialog";
import { Input } from "@/components/ui/input";
import { useParams } from "next/navigation";
import { useSWRConfig } from "swr";
import DriveList from "./DriveList";
import Link from "next/link";
import DriveSwitcher from "./workspace-selector";
import { useAuth } from "@/hooks/use-auth";
import { getPermissionErrorMessage } from "@/hooks/use-permissions";
import { useDriveStore } from "@/hooks/useDrive";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export default function Sidebar() {
    const [isCreatePageOpen, setCreatePageOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const params = useParams();
    const { driveId: driveIdParams } = params;
    const { user } = useAuth();
    const { drives, fetchDrives } = useDriveStore();

    const driveId = Array.isArray(driveIdParams) ? driveIdParams[0] : driveIdParams;
    const { mutate } = useSWRConfig();

    // Get drive from store and check if user can create pages
    const drive = drives.find(d => d.id === driveId);
    const canCreatePages = drive?.isOwned || false;

    // Fetch drives if not already loaded
    useEffect(() => {
        if (driveId && user?.id) {
            fetchDrives();
        }
    }, [driveId, user?.id, fetchDrives]);

    const handlePageCreated = () => {
        if (driveId) {
            mutate(`/api/drives/${driveId}/pages`);
        }
    };

  return (
    <aside className="hidden sm:block w-80 border-r bg-sidebar text-sidebar-foreground h-full">
      <div className="flex h-full flex-col gap-2 px-1 py-2">
        <DriveSwitcher />
        <div className="flex-1 overflow-auto py-2">
            {driveId ? (
                 <>
                    <div className="flex items-center gap-2 mb-4 px-1">
                        <div className="relative flex-grow">
                            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                placeholder="Search pages..."
                                className="pl-8 h-9"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
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
                                        <Button variant="ghost" size="icon" disabled className="opacity-50 cursor-not-allowed">
                                            <Lock className="h-5 w-5" />
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                        <p>{getPermissionErrorMessage('create')}</p>
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
            {driveId && (
                <Link href={`/dashboard/${driveId}/members`} className="flex items-center gap-2 p-2 rounded-lg hover:bg-accent hover:text-accent-foreground text-sm">
                    <Users className="h-4 w-4" />
                    Members
                </Link>
            )}
            <Link href={driveId ? `/dashboard/${driveId}/trash` : '/dashboard/trash'} className="flex items-center gap-2 p-2 rounded-lg hover:bg-accent hover:text-accent-foreground text-sm">
                <Trash2 className="h-4 w-4" />
                Trash
            </Link>
            {!driveId && (
                <>
                    <Link href="/dashboard/storage" className="flex items-center gap-2 p-2 rounded-lg hover:bg-accent hover:text-accent-foreground text-sm">
                        <HardDrive className="h-4 w-4" />
                        Storage
                    </Link>
                    <Link href="/settings" className="flex items-center gap-2 p-2 rounded-lg hover:bg-accent hover:text-accent-foreground text-sm">
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