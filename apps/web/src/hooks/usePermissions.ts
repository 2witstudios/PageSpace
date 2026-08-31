'use client';

import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { useAuth } from './useAuth';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

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

/**
 * Check if user can manage a drive (is owner or admin)
 * Works with drive objects from the store that have isOwned and role properties
 */
export function canManageDrive(drive: { isOwned?: boolean; role?: string } | null | undefined): boolean {
  if (!drive) return false;
  if (drive.isOwned === true) return true;
  // Check for ADMIN or OWNER role (case-insensitive for robustness)
  const role = drive.role?.toUpperCase();
  return role === 'ADMIN' || role === 'OWNER';
}

/**
 * Check if the user IS the drive's owner — stricter than {@link canManageDrive}.
 * An ADMIN can manage a drive's resources but must not be able to spend the
 * owner's money: use this (not `canManageDrive`) to gate anything that starts
 * or cancels a paid subscription on the owner's behalf.
 *
 * UI-ONLY. This has no server-side counterpart and is not the security
 * boundary — it derives a display decision from a `{isOwned, role}` DTO the
 * server already returned, the same shape `canManageDrive` above already
 * uses; there is nothing else in this codebase that expresses this exact
 * client-side check to reuse instead. The actual money-moving routes (e.g.
 * the dedicated-tier purchase/cancel endpoints) independently re-check
 * `drives.ownerId` server-side and do NOT trust this function or any
 * role-based permission helper for that decision (a role can be granted, and
 * "may spend this person's money" deliberately is not something a role
 * should be able to grant) — see that route's own docblock. A bug here can
 * at most show or hide a button; it cannot authorize a charge.
 */
export function isDriveOwner(drive: { isOwned?: boolean; role?: string } | null | undefined): boolean {
  if (!drive) return false;
  if (drive.isOwned === true) return true;
  return drive.role?.toUpperCase() === 'OWNER';
}