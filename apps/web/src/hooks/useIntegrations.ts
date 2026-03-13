'use client';

import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { SafeProvider, SafeConnection, SafeGrant, AuditLogEntry } from '@/components/integrations/types';

const fetcher = async (url: string) => {
  const res = await fetchWithAuth(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const sanitized = body.replace(/[\r\n]+/g, ' ').slice(0, 200);
    throw new Error(`Failed to fetch ${url}: ${res.status}${sanitized ? ` - ${sanitized}` : ''}`);
  }
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

export interface AuditLogsParams {
  limit?: number;
  offset?: number;
  connectionId?: string;
  success?: boolean;
  agentId?: string;
  dateFrom?: string;
  dateTo?: string;
  toolName?: string;
}

interface AvailableBuiltin {
  id: string;
  name: string;
  description: string | null;
  documentationUrl: string | null;
}

export function useAvailableBuiltins() {
  const { data, error, isLoading, mutate } = useSWR<{ providers: AvailableBuiltin[] }>(
    '/api/integrations/providers/available',
    fetcher,
    { revalidateOnFocus: false }
  );
  return { builtins: data?.providers ?? [], error, isLoading, mutate };
}

export function useConnectionGrantCount(connectionId: string | null) {
  const { data, error, isLoading } = useSWR<{ grants: SafeGrant[]; total: number }>(
    connectionId ? `/api/integrations/connections/${connectionId}/grants` : null,
    fetcher,
    { revalidateOnFocus: false }
  );
  return { count: data?.total ?? 0, error, isLoading };
}

export function useGoogleCalendarStatus() {
  const { data, error, isLoading } = useSWR<{
    connected: boolean;
    connection: {
      status: string;
      googleEmail: string;
      lastSyncAt: string | null;
    } | null;
    syncedEventCount: number;
  }>(
    '/api/integrations/google-calendar/status',
    fetcher,
    { revalidateOnFocus: false }
  );
  return {
    connected: data?.connected ?? false,
    connection: data?.connection ?? null,
    syncedEventCount: data?.syncedEventCount ?? 0,
    error,
    isLoading,
  };
}

export function useIntegrationAuditLogs(driveId: string | null, params: AuditLogsParams = {}) {
  const searchParams = new URLSearchParams();
  if (params.limit != null) searchParams.set('limit', String(params.limit));
  if (params.offset != null) searchParams.set('offset', String(params.offset));
  if (params.connectionId) searchParams.set('connectionId', params.connectionId);
  if (params.success !== undefined) searchParams.set('success', String(params.success));
  if (params.agentId) searchParams.set('agentId', params.agentId);
  if (params.dateFrom) searchParams.set('dateFrom', params.dateFrom);
  if (params.dateTo) searchParams.set('dateTo', params.dateTo);
  if (params.toolName) searchParams.set('toolName', params.toolName);

  const qs = searchParams.toString();
  const url = driveId ? `/api/drives/${driveId}/integrations/audit${qs ? `?${qs}` : ''}` : null;

  const { data, error, isLoading, mutate } = useSWR<{ logs: AuditLogEntry[]; total: number }>(
    url,
    fetcher,
    { revalidateOnFocus: false }
  );
  return { logs: data?.logs ?? [], total: data?.total ?? 0, error, isLoading, mutate };
}
