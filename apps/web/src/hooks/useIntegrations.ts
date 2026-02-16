'use client';

import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { SafeProvider, SafeConnection, SafeGrant, AuditLogEntry } from '@/components/integrations/types';

const fetcher = async (url: string) => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to fetch');
  return res.json();
};

export function useProviders() {
  const { data, error, isLoading, mutate } = useSWR<{ providers: SafeProvider[] }>(
    '/api/integrations/providers',
    fetcher,
    { revalidateOnFocus: false }
  );
  return { providers: data?.providers ?? [], error, isLoading, mutate };
}

export function useUserConnections() {
  const { data, error, isLoading, mutate } = useSWR<{ connections: SafeConnection[] }>(
    '/api/user/integrations',
    fetcher,
    { revalidateOnFocus: false }
  );
  return { connections: data?.connections ?? [], error, isLoading, mutate };
}

export function useDriveConnections(driveId: string | null) {
  const { data, error, isLoading, mutate } = useSWR<{ connections: SafeConnection[] }>(
    driveId ? `/api/drives/${driveId}/integrations` : null,
    fetcher,
    { revalidateOnFocus: false }
  );
  return { connections: data?.connections ?? [], error, isLoading, mutate };
}

export function useAgentGrants(agentId: string | null) {
  const { data, error, isLoading, mutate } = useSWR<{ grants: SafeGrant[] }>(
    agentId ? `/api/agents/${agentId}/integrations` : null,
    fetcher,
    { revalidateOnFocus: false }
  );
  return { grants: data?.grants ?? [], error, isLoading, mutate };
}

interface AuditLogsParams {
  limit?: number;
  offset?: number;
  connectionId?: string;
  success?: boolean;
}

export function useIntegrationAuditLogs(driveId: string | null, params: AuditLogsParams = {}) {
  const searchParams = new URLSearchParams();
  if (params.limit) searchParams.set('limit', String(params.limit));
  if (params.offset) searchParams.set('offset', String(params.offset));
  if (params.connectionId) searchParams.set('connectionId', params.connectionId);
  if (params.success !== undefined) searchParams.set('success', String(params.success));

  const qs = searchParams.toString();
  const url = driveId ? `/api/drives/${driveId}/integrations/audit${qs ? `?${qs}` : ''}` : null;

  const { data, error, isLoading, mutate } = useSWR<{ logs: AuditLogEntry[]; total: number }>(
    url,
    fetcher,
    { revalidateOnFocus: false }
  );
  return { logs: data?.logs ?? [], total: data?.total ?? 0, error, isLoading, mutate };
}
