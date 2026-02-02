"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Loader2, FolderInput, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { useDriveStore, Drive } from "@/hooks/useDrive";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";
import { SelectedPageInfo } from "@/stores/useMultiSelectStore";
import { cn } from "@/lib/utils";

interface TreeNode {
  id: string;
  title: string;
  type: string;
  children?: TreeNode[];
}

interface MovePageDialogProps {
  isOpen: boolean;
  onClose: () => void;
  pages: SelectedPageInfo[];
  onSuccess?: () => void;
}

export function MovePageDialog({
  isOpen,
  onClose,
  pages,
  onSuccess,
}: MovePageDialogProps) {
  const { drives, fetchDrives, isLoading: drivesLoading } = useDriveStore();
  const [selectedDriveId, setSelectedDriveId] = useState<string>("");
  const [selectedParentId, setSelectedParentId] = useState<string | null>(null);
  const [pageTree, setPageTree] = useState<TreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  // Filter out the pages being moved from tree display
  const movingPageIds = new Set(pages.map((p) => p.id));

  // Fetch drives on mount
  useEffect(() => {
    if (isOpen) {
      fetchDrives();
    }
  }, [isOpen, fetchDrives]);

  // Filter drives to only show ones where user has edit access
  const availableDrives = drives.filter(
    (d: Drive) => d.isOwned || d.role === "OWNER" || d.role === "ADMIN"
  );

  // Fetch page tree when drive changes
  useEffect(() => {
    if (!selectedDriveId) {
      setPageTree([]);
      return;
    }

    const fetchTree = async () => {
      setTreeLoading(true);
      try {
        const response = await fetchWithAuth("/api/pages/tree", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ driveId: selectedDriveId }),
        });
        if (response.ok) {
          const data = await response.json();
          setPageTree(data.tree || []);
        }
      } catch (error) {
        console.error("Failed to fetch page tree:", error);
      } finally {
        setTreeLoading(false);
      }
    };

    fetchTree();
  }, [selectedDriveId]);

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (isOpen) {
      // Set default drive to the first page's current drive, or first available
      const currentDriveId = pages[0]?.driveId;
      if (currentDriveId && availableDrives.some((d: Drive) => d.id === currentDriveId)) {
        setSelectedDriveId(currentDriveId);
      } else if (availableDrives.length > 0) {
        setSelectedDriveId(availableDrives[0].id);
      }
      setSelectedParentId(null);
      setExpandedNodes(new Set());
    }
  }, [isOpen, pages, availableDrives]);

  const toggleExpanded = useCallback((nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const handleMove = async () => {
    if (!selectedDriveId) {
      toast.error("Please select a destination drive");
      return;
    }

    setIsMoving(true);
    const toastId = toast.loading(
      `Moving ${pages.length} ${pages.length === 1 ? "page" : "pages"}...`
    );

    try {
      const response = await fetchWithAuth("/api/pages/bulk-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageIds: pages.map((p) => p.id),
          targetDriveId: selectedDriveId,
          targetParentId: selectedParentId,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to move pages");
      }

      toast.success(
        `Successfully moved ${pages.length} ${pages.length === 1 ? "page" : "pages"}`,
        { id: toastId }
      );
      onSuccess?.();
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to move pages",
        { id: toastId }
      );
    } finally {
      setIsMoving(false);
    }
  };

  // Recursive tree renderer
  const renderTreeNode = (node: TreeNode, depth: number = 0): React.ReactNode => {
    // Skip pages that are being moved
    if (movingPageIds.has(node.id)) {
      return null;
    }

    // Only show folders
    if (node.type !== "FOLDER") {
      return null;
    }

    const hasChildren = node.children && node.children.length > 0;
    const isExpanded = expandedNodes.has(node.id);
    const isSelected = selectedParentId === node.id;

    // Filter children recursively
    const filteredChildren = node.children?.filter(
      (child) => !movingPageIds.has(child.id) && child.type === "FOLDER"
    );

    return (
      <div key={node.id}>
        <div
          className={cn(
            "flex items-center px-2 py-1.5 rounded-md cursor-pointer transition-colors",
            isSelected
              ? "bg-primary text-primary-foreground"
              : "hover:bg-muted"
          )}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => setSelectedParentId(node.id)}
        >
          {hasChildren && filteredChildren && filteredChildren.length > 0 ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleExpanded(node.id);
              }}
              className="p-0.5 mr-1 rounded hover:bg-muted-foreground/20"
            >
              <ChevronRight
                className={cn(
                  "h-4 w-4 transition-transform",
                  isExpanded && "rotate-90"
                )}
              />
            </button>
          ) : (
            <span className="w-5" />
          )}
          <FolderInput className="h-4 w-4 mr-2 flex-shrink-0" />
          <span className="truncate text-sm">{node.title}</span>
        </div>
        {isExpanded && filteredChildren && filteredChildren.length > 0 && (
          <div>
            {filteredChildren.map((child) => renderTreeNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const pageNames = pages.map((p) => p.title).join(", ");
  const displayPageNames =
    pageNames.length > 50 ? pageNames.slice(0, 50) + "..." : pageNames;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Move {pages.length === 1 ? "Page" : "Pages"}</DialogTitle>
          <DialogDescription>
            Moving: <span className="font-medium">{displayPageNames}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="drive">Destination Drive</Label>
            <Select
              value={selectedDriveId}
              onValueChange={(value) => {
                setSelectedDriveId(value);
                setSelectedParentId(null);
              }}
              disabled={drivesLoading}
            >
              <SelectTrigger id="drive">
                <SelectValue placeholder="Select a drive" />
              </SelectTrigger>
              <SelectContent>
                {availableDrives.map((drive: Drive) => (
                  <SelectItem key={drive.id} value={drive.id}>
                    {drive.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Destination Folder (optional)</Label>
            <div className="border rounded-md max-h-[200px] overflow-y-auto p-2">
              {treeLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <>
                  <div
                    className={cn(
                      "flex items-center px-2 py-1.5 rounded-md cursor-pointer transition-colors",
                      selectedParentId === null
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted"
                    )}
                    onClick={() => setSelectedParentId(null)}
                  >
                    <FolderInput className="h-4 w-4 mr-2" />
                    <span className="text-sm font-medium">Root (Top Level)</span>
                  </div>
                  {pageTree.map((node) => renderTreeNode(node))}
                </>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isMoving}>
            Cancel
          </Button>
          <Button onClick={handleMove} disabled={!selectedDriveId || isMoving}>
            {isMoving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Move {pages.length === 1 ? "Page" : `${pages.length} Pages`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
