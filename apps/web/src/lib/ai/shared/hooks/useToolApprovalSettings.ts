import { useCallback } from 'react';
import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

export type ToolApprovalMode = 'ask' | 'auto';

export interface TrustedToolGrant {
  id: string;
  toolName: string;
  /** `null` = always; a conversation id = that conversation only. */
  conversationId: string | null;
  createdAt: string;
}

const CONFIG_URL = '/api/user/assistant-config';
const GRANTS_URL = '/api/user/assistant-config/tool-grants';

const fetchJson = async <T,>(url: string): Promise<T> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  return (await response.json()) as T;
};

/**
 * The user's tool-approval settings for the GLOBAL assistant: the ask|auto
 * mode and the standing "always allow" / "allow for this conversation" grants,
 * with the two writes the composer's Tools menu needs. Page agents carry their
 * own mode on the agent's settings tab, not here.
 *
 * Server-persisted (assistant-config), unlike the composer's other toggles,
 * because the server is what enforces it — a mode that lived only in this tab's
 * localStorage would not survive to the next device or the next turn.
 */
export function useToolApprovalSettings(options: { enabled?: boolean } = {}) {
  const enabled = options.enabled ?? true;
  const config = useSWR<{ config: { toolApprovalMode?: ToolApprovalMode } }>(enabled ? CONFIG_URL : null, fetchJson, {
    revalidateOnFocus: false,
  });
  const grants = useSWR<{ grants: TrustedToolGrant[] }>(enabled ? GRANTS_URL : null, fetchJson, {
    revalidateOnFocus: false,
  });

  const mode: ToolApprovalMode = config.data?.config.toolApprovalMode ?? 'ask';

  const setMode = useCallback(
    async (next: ToolApprovalMode) => {
      await config.mutate(
        async () => {
          const response = await fetchWithAuth(CONFIG_URL, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ toolApprovalMode: next }),
          });
          if (!response.ok) throw new Error(`Failed to save approval mode: ${response.status}`);
          return (await response.json()) as { config: { toolApprovalMode?: ToolApprovalMode } };
        },
        { optimisticData: { config: { ...(config.data?.config ?? {}), toolApprovalMode: next } }, rollbackOnError: true, revalidate: false },
      );
    },
    [config],
  );

  const revokeGrant = useCallback(
    async (grantId: string) => {
      const remaining = (grants.data?.grants ?? []).filter((grant) => grant.id !== grantId);
      await grants.mutate(
        async () => {
          const response = await fetchWithAuth(GRANTS_URL, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ grantId }),
          });
          if (!response.ok && response.status !== 404) throw new Error(`Failed to revoke grant: ${response.status}`);
          return { grants: remaining };
        },
        { optimisticData: { grants: remaining }, rollbackOnError: true, revalidate: false },
      );
    },
    [grants],
  );

  return {
    mode,
    isLoading: config.isLoading,
    grants: grants.data?.grants ?? [],
    setMode,
    revokeGrant,
    /** Re-read the grants (e.g. after an "Always allow" click elsewhere on the page). */
    refreshGrants: grants.mutate,
  };
}
