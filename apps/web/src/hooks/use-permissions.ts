'use client';

import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { useAuth } from './use-auth';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';

export interface PagePermissions {
  canView: boolean;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
}

interface UsePermissionsResult {
  permissions: PagePermissions | null;
  isLoading: boolean;
  error: Error | null;
  isOwner: boolean;
}

const defaultPermissions: PagePermissions = {
  canView: false,
  canEdit: false,
  canShare: false,
  canDelete: false,
};

/**
 * Hook to fetch and manage user permissions for a page or drive
 */
export function usePermissions(pageId?: string | null, driveOwnerId?: string): UsePermissionsResult {
  const { user } = useAuth();
  const [isOwner, setIsOwner] = useState(false);
  const isAnyActive = useEditingStore((state) => state.isAnyActive());

  // Check if user is drive owner
  useEffect(() => {
    if (user?.id && driveOwnerId) {
      setIsOwner(user.id === driveOwnerId);
    }
  }, [user?.id, driveOwnerId]);

  // Fetch permissions from API
  const { data, error, isLoading } = useSWR<PagePermissions>(
    pageId && user?.id ? `/api/pages/${pageId}/permissions/check` : null,
    async (url) => {
      const response = await fetchWithAuth(url);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return defaultPermissions;
        }
        throw new Error('Failed to fetch permissions');
      }
      return response.json();
    },
    {
      isPaused: () => isAnyActive,
      revalidateOnFocus: false,
      dedupingInterval: 60000, // Cache for 1 minute
    }
  );

  // If user is drive owner, they have all permissions
  if (isOwner) {
    return {
      permissions: {
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      },
      isLoading: false,
      error: null,
      isOwner: true,
    };
  }

  return {
    permissions: data || null,
    isLoading,
    error,
    isOwner: false,
  };
}

/**
 * Hook to check a single permission
 */
export function useCanEdit(pageId?: string | null, driveOwnerId?: string): boolean {
  const { permissions } = usePermissions(pageId, driveOwnerId);
  return permissions?.canEdit || false;
}

export function useCanShare(pageId?: string | null, driveOwnerId?: string): boolean {
  const { permissions } = usePermissions(pageId, driveOwnerId);
  return permissions?.canShare || false;
}

export function useCanDelete(pageId?: string | null, driveOwnerId?: string): boolean {
  const { permissions } = usePermissions(pageId, driveOwnerId);
  return permissions?.canDelete || false;
}

/**
 * Get permission error message
 */
export function getPermissionErrorMessage(action: string, resource: string = 'page'): string {
  const actionMessages: Record<string, string> = {
    view: `You don't have permission to view this ${resource}`,
    edit: `You need edit permission to modify this ${resource}`,
    share: `You need share permission to invite others to this ${resource}`,
    delete: `You need delete permission to remove this ${resource}`,
    create: `You need edit permission in the parent folder to create new pages`,
    send: `You need edit permission to send messages in this channel`,
    restore: `You need edit permission to restore pages from trash`,
  };

  return actionMessages[action] || `You don't have permission to ${action} this ${resource}`;
}