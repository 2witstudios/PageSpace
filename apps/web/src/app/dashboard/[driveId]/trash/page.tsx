"use client";

import { usePageTree } from "@/hooks/usePageTree";
import PageTree from "@/components/layout/left-sidebar/page-tree/PageTree";
import { useParams } from "next/navigation";
import { useDriveStore } from "@/hooks/useDrive";
import { useEffect } from "react";

export default function TrashPage() {
  const params = useParams();
  const driveId = params.driveId as string;
  const { tree, isLoading, isError, mutate } = usePageTree(driveId, true);
  const drives = useDriveStore((state) => state.drives);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);
  
  const drive = drives.find(d => d.id === driveId);

  // Fetch drives if not already loaded
  useEffect(() => {
    if (driveId && !drive) {
      fetchDrives();
    }
  }, [driveId, drive, fetchDrives]);

  if (isLoading) return <div>Loading...</div>;
  if (isError) return <div>Failed to load trash.</div>;

  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold mb-4">Trash</h1>
      <PageTree driveId={driveId} initialTree={tree} mutate={mutate} isTrashView={true} />
    </div>
  );
}
