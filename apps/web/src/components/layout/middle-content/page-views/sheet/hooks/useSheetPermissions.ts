import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

/**
 * Shell hook that resolves whether the current user may edit the sheet. The
 * permission check is aborted on unmount/re-run; a read-only result surfaces a
 * one-time toast.
 */
export const useSheetPermissions = (pageId: string, userId: string | undefined): boolean => {
  const [isReadOnly, setIsReadOnly] = useState(false);

  useEffect(() => {
    const abortController = new AbortController();

    const checkPermissions = async () => {
      if (!userId) return;
      try {
        const response = await fetchWithAuth(
          `/api/pages/${pageId}/permissions/check?userId=${encodeURIComponent(userId)}`,
          { signal: abortController.signal }
        );
        if (response.ok) {
          const permissions = await response.json();
          setIsReadOnly(!permissions.canEdit);
          if (!permissions.canEdit) {
            toast.info("You don't have permission to edit this sheet", {
              duration: 4000,
              position: 'bottom-right',
            });
          }
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;
        console.error('Failed to check permissions:', error);
      }
    };

    checkPermissions();
    return () => {
      abortController.abort();
    };
  }, [pageId, userId]);

  return isReadOnly;
};
