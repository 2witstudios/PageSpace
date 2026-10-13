'use client';

import { useState, useEffect, useRef, forwardRef, useImperativeHandle, useCallback, type ReactNode } from 'react';
import { Checkbox } from '@/retained/components/ui/checkbox';
import { Button } from '@/retained/components/ui/button';
import { ChevronRight, ChevronDown, HardDrive } from 'lucide-react';
import { PageTypeIcon } from '@/retained/components/common/PageTypeIcon';
import { PageType } from '@pagespace/lib/utils/enums';
import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';

export interface PageNode {
  id: string;
  title: string;
  type: string;
  children: PageNode[];
  currentPermissions?: {
    canView: boolean;
    canEdit: boolean;
    canShare: boolean;
  };
}

interface PermissionsGridProps {
  driveId: string;
  userId?: string;
  permissions: Map<string, { canView: boolean; canEdit: boolean; canShare: boolean }>;
  onChange: (pageId: string, perms: { canView: boolean; canEdit: boolean; canShare: boolean }) => void;
  /** When true, the drive root row is shown as informational only (checkboxes disabled).
   *  Use in member management context where drive-level access is derived from membership role,
   *  not from the permissions JSONB. */
  readOnlyDriveRoot?: boolean;
  /** Told the page tree once it loads, so a caller can name the pages it changed. */
  onTreeLoaded?: (pages: readonly PageNode[]) => void;
}

const NO_PERMISSIONS = { canView: false, canEdit: false, canShare: false } as const;

/** One treegrid row: Page, View, Edit, Share, and the Apply-to-children cell. */
const permissionRowClass = 'grid grid-cols-[minmax(0,1fr)_64px_64px_64px_112px] items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0';

export interface PermissionsGridRef {
  applyRolePermissions: (rolePerms: Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>) => void;
}

export const PermissionsGrid = forwardRef<PermissionsGridRef, PermissionsGridProps>(function PermissionsGrid(
  { driveId, userId, permissions, onChange, readOnlyDriveRoot = false, onTreeLoaded },
  ref
) {
  const [pages, setPages] = useState<PageNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const pendingRolePermissionsRef = useRef<Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }> | null>(null);

  useEffect(() => {
    fetchPermissionTree();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driveId, userId]);

  // Helper to apply permissions to all pages in tree
  const applyPermissionsToTree = useCallback((rolePerms: Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>, nodes: PageNode[]) => {
    const applyRecursive = (permsMap: typeof rolePerms, nodeList: PageNode[]) => {
      nodeList.forEach(node => {
        if (node.type === 'DRIVE' && readOnlyDriveRoot) return;
        const perms = permsMap[node.id];
        onChange(node.id, perms || { canView: false, canEdit: false, canShare: false });
        if (node.children) applyRecursive(permsMap, node.children);
      });
    };
    applyRecursive(rolePerms, nodes);
  }, [onChange, readOnlyDriveRoot]);

  // Expose applyRolePermissions to parent via ref
  useImperativeHandle(ref, () => ({
    applyRolePermissions: (rolePerms: Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>) => {
      if (pages.length === 0) {
        // Pages not loaded yet - store for later
        pendingRolePermissionsRef.current = rolePerms;
        return;
      }
      // Apply immediately
      applyPermissionsToTree(rolePerms, pages);
    }
  }), [pages, applyPermissionsToTree]);

  // Apply pending role permissions once pages load
  useEffect(() => {
    if (pages.length > 0 && pendingRolePermissionsRef.current) {
      const rolePerms = pendingRolePermissionsRef.current;
      pendingRolePermissionsRef.current = null;
      applyPermissionsToTree(rolePerms, pages);
    }
  }, [pages, applyPermissionsToTree]);

  const fetchPermissionTree = async () => {
    try {
      const url = userId
        ? `/api/drives/${driveId}/permissions-tree?userId=${userId}`
        : `/api/drives/${driveId}/permissions-tree`;

      const response = await fetchWithAuth(url);
      if (!response.ok) throw new Error('Failed to fetch permission tree');

      const data = await response.json();
      setPages(data.pages);
      onTreeLoaded?.(data.pages);
      
      // Initialize permissions with current permissions if available
      if (userId && data.pages) {
        const initPermissions = (nodes: PageNode[]) => {
          nodes.forEach(node => {
            if (node.currentPermissions) {
              onChange(node.id, node.currentPermissions);
            }
            if (node.children) {
              initPermissions(node.children);
            }
          });
        };
        initPermissions(data.pages);
      }
    } catch (error) {
      console.error('Error fetching permission tree:', error);
    } finally {
      setLoading(false);
    }
  };

  const toggleExpanded = (pageId: string) => {
    const newExpanded = new Set(expandedNodes);
    if (newExpanded.has(pageId)) {
      newExpanded.delete(pageId);
    } else {
      newExpanded.add(pageId);
    }
    setExpandedNodes(newExpanded);
  };


  const handlePermissionChange = (pageId: string, permType: 'canView' | 'canEdit' | 'canShare', value: boolean) => {
    const currentPerms = permissions.get(pageId) || { canView: false, canEdit: false, canShare: false };
    const newPerms = { ...currentPerms };
    
    // Handle permission dependencies
    if (permType === 'canView' && !value) {
      // If removing view, remove edit and share too
      newPerms.canView = false;
      newPerms.canEdit = false;
      newPerms.canShare = false;
    } else if (permType === 'canEdit' && value) {
      // If granting edit, must have view
      newPerms.canView = true;
      newPerms.canEdit = true;
    } else if (permType === 'canShare' && value) {
      // If granting share, must have view
      newPerms.canView = true;
      newPerms.canShare = true;
    } else {
      newPerms[permType] = value;
    }
    
    onChange(pageId, newPerms);
  };

  const applyToChildren = (pageId: string, perms: { canView: boolean; canEdit: boolean; canShare: boolean }) => {
    const applyRecursively = (nodes: PageNode[]) => {
      nodes.forEach(node => {
        onChange(node.id, { ...perms });
        if (node.children && node.children.length > 0) {
          applyRecursively(node.children);
        }
      });
    };
    
    const findAndApply = (nodes: PageNode[]) => {
      for (const node of nodes) {
        if (node.id === pageId && node.children) {
          applyRecursively(node.children);
          break;
        }
        if (node.children) {
          findAndApply(node.children);
        }
      }
    };
    
    findAndApply(pages);
  };

  const selectAll = () => {
    const applyToAll = (nodes: PageNode[]) => {
      nodes.forEach(node => {
        if (node.type === 'DRIVE' && readOnlyDriveRoot) return;
        onChange(node.id, { canView: true, canEdit: false, canShare: false });
        if (node.children) applyToAll(node.children);
      });
    };
    applyToAll(pages);
  };

  const selectAllPermissions = () => {
    const applyToAll = (nodes: PageNode[]) => {
      nodes.forEach(node => {
        if (node.type === 'DRIVE' && readOnlyDriveRoot) return;
        onChange(node.id, { canView: true, canEdit: true, canShare: true });
        if (node.children) applyToAll(node.children);
      });
    };
    applyToAll(pages);
  };

  const selectNone = () => {
    const clearAll = (nodes: PageNode[]) => {
      nodes.forEach(node => {
        if (node.type === 'DRIVE' && readOnlyDriveRoot) return;
        onChange(node.id, { canView: false, canEdit: false, canShare: false });
        if (node.children) clearAll(node.children);
      });
    };
    clearAll(pages);
  };

  const checkboxCell = (page: PageNode, perm: 'canView' | 'canEdit' | 'canShare', label: string, disabled: boolean) => (
    <div role="gridcell" className="flex justify-center">
      <Checkbox
        aria-label={`${label} ${page.title}`}
        checked={(permissions.get(page.id) ?? NO_PERMISSIONS)[perm]}
        disabled={disabled}
        onCheckedChange={(checked) => handlePermissionChange(page.id, perm, !!checked)}
      />
    </div>
  );

  const renderDriveRootRow = (page: PageNode) => {
    const perms = permissions.get(page.id) ?? NO_PERMISSIONS;
    return (
      <div key={page.id} role="row" className={permissionRowClass}>
        <div role="gridcell" className="flex min-w-0 items-center gap-2 font-medium">
          <HardDrive className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{page.title}</span>
          <span className="truncate text-xs text-muted-foreground">
            {readOnlyDriveRoot ? '(access derived from membership role)' : '(controls root-level page creation)'}
          </span>
        </div>
        {checkboxCell(page, 'canView', 'View', readOnlyDriveRoot)}
        <div role="gridcell" className="flex justify-center">
          <Checkbox aria-label={`Edit ${page.title}`} checked={perms.canEdit} disabled={readOnlyDriveRoot || !perms.canView} onCheckedChange={(checked) => handlePermissionChange(page.id, 'canEdit', !!checked)} />
        </div>
        <div role="gridcell" className="flex justify-center">
          <Checkbox aria-label={`Share ${page.title}`} checked={perms.canShare} disabled={readOnlyDriveRoot || !perms.canView} onCheckedChange={(checked) => handlePermissionChange(page.id, 'canShare', !!checked)} />
        </div>
        <div role="gridcell" />
      </div>
    );
  };

  /** One page row, then its children when the row is expanded: a treegrid is flat rows with a depth. */
  const renderPageRows = (page: PageNode, depth: number = 0): ReactNode[] => {
    if (page.type === 'DRIVE') {
      return [renderDriveRootRow(page)];
    }

    const perms = permissions.get(page.id) ?? NO_PERMISSIONS;
    const hasChildren = page.children && page.children.length > 0;
    const isExpanded = expandedNodes.has(page.id);

    const row = (
      <div key={page.id} role="row" aria-level={depth + 1} className={permissionRowClass}>
        <div role="gridcell" className="flex min-w-0 items-center gap-1" style={{ paddingLeft: `${depth * 20}px` }}>
          {hasChildren ? (
            <button
              type="button"
              aria-expanded={isExpanded}
              aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${page.title}`}
              onClick={() => toggleExpanded(page.id)}
              className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent"
            >
              {isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            </button>
          ) : (
            <span className="size-5 shrink-0" aria-hidden="true" />
          )}
          <PageTypeIcon type={page.type as PageType} className="size-4 shrink-0" />
          <span className="truncate">{page.title}</span>
        </div>
        {checkboxCell(page, 'canView', 'View', false)}
        <div role="gridcell" className="flex justify-center">
          <Checkbox aria-label={`Edit ${page.title}`} checked={perms.canEdit} disabled={!perms.canView} onCheckedChange={(checked) => handlePermissionChange(page.id, 'canEdit', !!checked)} />
        </div>
        <div role="gridcell" className="flex justify-center">
          <Checkbox aria-label={`Share ${page.title}`} checked={perms.canShare} disabled={!perms.canView} onCheckedChange={(checked) => handlePermissionChange(page.id, 'canShare', !!checked)} />
        </div>
        <div role="gridcell" className="flex justify-end">
          {hasChildren && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => applyToChildren(page.id, perms)}
            >
              Apply to children
            </Button>
          )}
        </div>
      </div>
    );

    return [row, ...(hasChildren && isExpanded ? page.children.flatMap((child) => renderPageRows(child, depth + 1)) : [])];
  };

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <div className="size-8 animate-spin rounded-full border-b-2 border-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Bulk actions" className="flex w-fit gap-0.5 rounded-lg bg-muted p-0.5">
        <Button type="button" variant="ghost" size="sm" onClick={selectAll}>View all</Button>
        <Button type="button" variant="ghost" size="sm" onClick={selectAllPermissions}>Full access</Button>
        <Button type="button" variant="ghost" size="sm" onClick={selectNone}>Clear</Button>
      </div>
      <div role="treegrid" aria-label="Page permissions" className="overflow-hidden rounded-xl border border-border">
        <div role="row" className={`${permissionRowClass} text-xs font-medium text-muted-foreground`}>
          <div role="columnheader">Page</div>
          <div role="columnheader" className="text-center">View</div>
          <div role="columnheader" className="text-center">Edit</div>
          <div role="columnheader" className="text-center">Share</div>
          <div role="columnheader" />
        </div>
        <div className="max-h-96 overflow-y-auto">
          {pages.flatMap((page) => renderPageRows(page))}
        </div>
      </div>
    </div>
  );
});