/**
 * useAccessRevocation - Client-side handler for real-time permission revocation
 *
 * When the server kicks a user from a room due to permission revocation,
 * this hook handles the graceful client-side response:
 * - Shows a notification explaining what happened
 * - Redirects to a safe location if the user is on the revoked resource
 * - Cleans up local state as needed
 */

import { useEffect, useCallback, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { useSocketStore } from '@/stores/useSocketStore';

interface AccessRevokedPayload {
  room: string;
  reason: 'member_removed' | 'role_changed' | 'permission_revoked' | 'session_revoked';
  metadata?: {
    driveId?: string;
    pageId?: string;
    driveName?: string;
  };
}

/**
 * Determines if the user is currently viewing the revoked resource
 * and needs to be redirected
 */
function shouldRedirect(pathname: string, payload: AccessRevokedPayload): boolean {
  const { room, metadata } = payload;

  // Check if user is in the affected drive
  if (room.startsWith('drive:') && metadata?.driveId) {
    // User is viewing something in this drive
    if (pathname.includes(`/drives/${metadata.driveId}`)) {
      return true;
    }
    // Also check if pathname includes the drive ID in any format
    if (pathname.includes(metadata.driveId)) {
      return true;
    }
  }

  // Check if user is viewing the affected page
  if (metadata?.pageId) {
    if (pathname.includes(`/pages/${metadata.pageId}`)) {
      return true;
    }
    if (pathname.includes(metadata.pageId)) {
      return true;
    }
  }

  return false;
}

/**
 * Gets a human-readable message for the revocation reason
 */
function getRevocationMessage(payload: AccessRevokedPayload): string {
  const { reason, metadata } = payload;

  switch (reason) {
    case 'member_removed':
      return metadata?.driveName
        ? `You've been removed from "${metadata.driveName}"`
        : "You've been removed from this workspace";

    case 'role_changed':
      return metadata?.driveName
        ? `Your role in "${metadata.driveName}" has changed`
        : 'Your access level has changed';

    case 'permission_revoked':
      return 'Your access to this page has been revoked';

    case 'session_revoked':
      return 'Your session has been revoked. Please log in again.';

    default:
      return 'Your access has been revoked';
  }
}

/**
 * Hook to handle access revocation events from the realtime server.
 * Should be mounted at the app level to ensure all revocations are handled.
 */
export function useAccessRevocation() {
  const router = useRouter();
  const pathname = usePathname();
  // Subscribe to socket instance directly so effect re-runs on reconnect
  const socket = useSocketStore((state) => state.socket);

  // Use ref to track handled rooms and prevent duplicate toasts
  const handledRooms = useRef(new Set<string>());

  const handleAccessRevoked = useCallback(
    (payload: AccessRevokedPayload) => {
      const { room, reason, metadata } = payload;

      // Skip activity rooms - they're silent (the main room revocation handles notification)
      if (room.startsWith('activity:')) {
        return;
      }

      // Prevent duplicate handling for the same room in quick succession
      if (handledRooms.current.has(room)) {
        return;
      }
      handledRooms.current.add(room);
      // Clear after 5 seconds to allow future revocations
      setTimeout(() => handledRooms.current.delete(room), 5000);

      // Log for debugging
      console.log('🚫 Access revoked:', { room, reason, metadata });

      // Show notification
      const message = getRevocationMessage(payload);
      toast.error(message, {
        duration: 5000,
        description: 'You no longer have access to this resource.',
      });

      // Redirect if user is currently viewing the revoked resource
      if (shouldRedirect(pathname, payload)) {
        // Session revocation goes to login, others go to dashboard
        if (reason === 'session_revoked') {
          router.push('/auth/login');
        } else {
          router.push('/dashboard');
        }
      }
    },
    [pathname, router]
  );

  useEffect(() => {
    if (!socket) return;

    socket.on('access_revoked', handleAccessRevoked);

    return () => {
      socket.off('access_revoked', handleAccessRevoked);
    };
  }, [socket, handleAccessRevoked]);
}
