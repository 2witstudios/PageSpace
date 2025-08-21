'use client';

import { useEffect } from 'react';
import { useDirtyStore } from '@/stores/useDirtyStore';
import { toast } from 'sonner';

export function useUnsavedChanges() {
  const hasDirtyDocuments = useDirtyStore((state) => state.hasDirtyDocuments);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasDirtyDocuments()) {
        e.preventDefault();
        e.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
        return e.returnValue;
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [hasDirtyDocuments]);

  const confirmNavigation = async (): Promise<boolean> => {
    if (!hasDirtyDocuments()) {
      return true;
    }

    return new Promise((resolve) => {
      toast.warning('You have unsaved changes.', {
        description: 'Are you sure you want to leave without saving?',
        action: {
          label: 'Leave',
          onClick: () => resolve(true),
        },
        cancel: {
          label: 'Stay',
          onClick: () => resolve(false),
        },
      });
    });
  };

  return { confirmNavigation };
}