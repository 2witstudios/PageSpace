'use client';

/**
 * Read-only gating for the agent page: `true` when the viewer cannot edit the
 * page. Fail-open to editable (the server enforces regardless) — matching the
 * inline effect this was extracted from.
 */
import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

export function usePermissionsCheck(pageId: string, userId: string | undefined): boolean {
  const [isReadOnly, setIsReadOnly] = useState(false);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetchWithAuth(`/api/pages/${pageId}/permissions/check`);
        if (cancelled || !response.ok) return;
        const permissions = await response.json();
        if (!cancelled) setIsReadOnly(!permissions.canEdit);
      } catch (error) {
        console.error('Failed to check permissions:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, pageId]);

  return isReadOnly;
}
