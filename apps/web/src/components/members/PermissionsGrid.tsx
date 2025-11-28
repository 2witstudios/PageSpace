'use client';

import { useState, useEffect, useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { PageType } from '@pagespace/lib/client-safe';
import { fetchWithAuth } from '@/lib/auth-fetch';

interface PageNode {
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
}

export interface PermissionsGridRef {
  applyRolePermissions: (rolePerms: Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>) => void;
}

export const PermissionsGrid = forwardRef<PermissionsGridRef, PermissionsGridProps>(function PermissionsGrid(
  { driveId, userId, permissions, onChange },
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
        const perms = permsMap[node.id];
        onChange(node.id, perms || { canView: false, canEdit: false, canShare: false });
        if (node.children) applyRecursive(permsMap, node.children);
      });
    };
    applyRecursive(rolePerms, nodes);
  }, [onChange]);

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
        onChange(node.id, { canView: true, canEdit: false, canShare: false });
        if (node.children) applyToAll(node.children);
      });
    };
    applyToAll(pages);
  };

  const selectAllPermissions = () => {
    const applyToAll = (nodes: PageNode[]) => {
      nodes.forEach(node => {
        onChange(node.id, { canView: true, canEdit: true, canShare: true });
        if (node.children) applyToAll(node.children);
      });
    };
    applyToAll(pages);
  };

  const selectNone = () => {
    const clearAll = (nodes: PageNode[]) => {
      nodes.forEach(node => {
        onChange(node.id, { canView: false, canEdit: false, canShare: false });
        if (node.children) clearAll(node.children);
      });
    };
    clearAll(pages);
  };

  const renderPageRow = (page: PageNode, depth: number = 0) => {
    const perms = permissions.get(page.id) || { canView: false, canEdit: false, canShare: false };
    const hasChildren = page.children && page.children.length > 0;
    const isExpanded = expandedNodes.has(page.id);

    return (
      <div key={page.id}>
        <div className="flex items-center p-2 bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
          {/* Page Name with Indentation */}
          <div 
            className="flex-1 flex items-center cursor-pointer"
            style={{ paddingLeft: `${depth * 20}px` }}
            onClick={() => hasChildren && toggleExpanded(page.id)}
          >
            {hasChildren && (
              <button className="mr-1">
                {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
            )}
            <div className="flex items-center space-x-2">
              <PageTypeIcon type={page.type as PageType} className="w-4 h-4" />
              <span className="truncate">{page.title}</span>
            </div>
            {hasChildren && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  applyToChildren(page.id, perms);
                }}
                className="ml-2 text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
              >
                Apply to children
              </button>
            )}
          </div>
          
          {/* Permission Checkboxes */}
          <div className="w-[100px] flex justify-center">
            <Checkbox 
              checked={perms.canView}
              onCheckedChange={(checked) => handlePermissionChange(page.id, 'canView', !!checked)}
            />
          </div>
          <div className="w-[100px] flex justify-center">
            <Checkbox 
              checked={perms.canEdit}
              disabled={!perms.canView}
              onCheckedChange={(checked) => handlePermissionChange(page.id, 'canEdit', !!checked)}
            />
          </div>
          <div className="w-[100px] flex justify-center">
            <Checkbox 
              checked={perms.canShare}
              disabled={!perms.canView}
              onCheckedChange={(checked) => handlePermissionChange(page.id, 'canShare', !!checked)}
            />
          </div>
        </div>
        
        {/* Render Children */}
        {hasChildren && isExpanded && (
          <div>
            {page.children.map(child => renderPageRow(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 dark:border-gray-100" />
      </div>
    );
  }

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center p-2 bg-gray-100 dark:bg-gray-800 font-semibold text-sm sticky top-0">
        <div className="flex-1">Page Tree</div>
        <div className="w-[100px] text-center">View</div>
        <div className="w-[100px] text-center">Edit</div>
        <div className="w-[100px] text-center">Share</div>
      </div>
      
      {/* Page Tree */}
      <div className="max-h-96 overflow-y-auto">
        {pages.map(page => renderPageRow(page))}
      </div>
      
      {/* Quick Actions */}
      <div className="border-t border-gray-200 dark:border-gray-700 p-3 bg-gray-50 dark:bg-gray-800 flex gap-2">
        <Button size="sm" variant="outline" onClick={selectAllPermissions}>
          Select All
        </Button>
        <Button size="sm" variant="outline" onClick={selectAll}>
          Select All View
        </Button>
        <Button size="sm" variant="outline" onClick={selectNone}>
          Clear All
        </Button>
      </div>
    </div>
  );
});