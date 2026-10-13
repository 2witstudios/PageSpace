import { useEffect } from 'react';
import { toast } from 'sonner';
import { usePermissions } from '@/retained/hooks/usePermissions';

/** The sheet stays read-only until the existing permission API grants editing. */
export const useSheetPermissions = (pageId: string, userId: string | undefined): boolean => {
  const { permissions } = usePermissions(pageId);
  useEffect(() => {
    if (userId && permissions && !permissions.canEdit) {
      toast.info("You don't have permission to edit this sheet", {
        duration: 4000,
        position: 'bottom-right',
      });
    }
  }, [userId, permissions]);
  return permissions?.canEdit !== true;
};
