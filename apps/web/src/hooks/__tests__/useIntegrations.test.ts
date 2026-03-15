/**
 * useIntegrations Hook Tests
 *
 * Tests for all SWR hooks in the integrations module:
 * - useProviders, useUserConnections, useDriveConnections
 * - useAgentGrants, useAvailableBuiltins, useConnectionGrantCount
 * - useGoogleCalendarStatus, useIntegrationAuditLogs
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SWRResponse } from 'swr';

const mockFetchWithAuth = vi.hoisted(() => vi.fn());
const mockUseSWR = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mockFetchWithAuth,
}));

vi.mock('swr', () => ({
  default: mockUseSWR,
}));

import {
  useProviders,
  useUserConnections,
  useDriveConnections,
  useAgentGrants,
  useAvailableBuiltins,
  useConnectionGrantCount,
  useGoogleCalendarStatus,
  useIntegrationAuditLogs,
} from '../useIntegrations';

function createSWRResponse(overrides: Partial<SWRResponse> = {}): SWRResponse {
  return {
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
    isValidating: false,
    ...overrides,
  } as SWRResponse;
}

describe('useIntegrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('useProviders', () => {
    it('should return empty providers when no data', () => {
      mockUseSWR.mockReturnValue(createSWRResponse({ isLoading: true }));

      const { result } = renderHook(() => useProviders());

      expect(result.current.providers).toEqual([]);
      expect(result.current.isLoading).toBe(true);
    });

    it('should pass correct SWR key', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      renderHook(() => useProviders());

      expect(mockUseSWR).toHaveBeenCalledWith(
        '/api/integrations/providers',
        expect.any(Function),
        expect.objectContaining({ revalidateOnFocus: false })
      );
    });

    it('should return providers when data is available', () => {
      const providers = [
        { id: '1', name: 'GitHub', type: 'oauth' },
        { id: '2', name: 'Slack', type: 'oauth' },
      ];
      mockUseSWR.mockReturnValue(createSWRResponse({ data: { providers } }));

      const { result } = renderHook(() => useProviders());

      expect(result.current.providers).toEqual(providers);
    });

    it('should expose error and mutate', () => {
      const error = new Error('Failed');
      const mutate = vi.fn();
      mockUseSWR.mockReturnValue(createSWRResponse({ error, mutate }));

      const { result } = renderHook(() => useProviders());

      expect(result.current.error).toBe(error);
      expect(result.current.mutate).toBe(mutate);
    });
  });

  describe('useUserConnections', () => {
    it('should return empty connections when no data', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      const { result } = renderHook(() => useUserConnections());

      expect(result.current.connections).toEqual([]);
    });

    it('should pass correct SWR key', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      renderHook(() => useUserConnections());

      expect(mockUseSWR).toHaveBeenCalledWith(
        '/api/user/integrations',
        expect.any(Function),
        expect.objectContaining({ revalidateOnFocus: false })
      );
    });

    it('should return connections when data is available', () => {
      const connections = [{ id: 'conn-1', providerId: 'p1', status: 'active' }];
      mockUseSWR.mockReturnValue(createSWRResponse({ data: { connections } }));

      const { result } = renderHook(() => useUserConnections());

      expect(result.current.connections).toEqual(connections);
    });
  });

  describe('useDriveConnections', () => {
    it('should return empty connections when no data', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      const { result } = renderHook(() => useDriveConnections('drive-1'));

      expect(result.current.connections).toEqual([]);
    });

    it('should pass correct SWR key with driveId', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      renderHook(() => useDriveConnections('drive-1'));

      expect(mockUseSWR).toHaveBeenCalledWith(
        '/api/drives/drive-1/integrations',
        expect.any(Function),
        expect.objectContaining({ revalidateOnFocus: false })
      );
    });

    it('should pass null key when driveId is null', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      renderHook(() => useDriveConnections(null));

      expect(mockUseSWR).toHaveBeenCalledWith(
        null,
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('should return connections when data is available', () => {
      const connections = [{ id: 'conn-1', providerId: 'p1', status: 'active' }];
      mockUseSWR.mockReturnValue(createSWRResponse({ data: { connections } }));

      const { result } = renderHook(() => useDriveConnections('drive-1'));

      expect(result.current.connections).toEqual(connections);
    });
  });

  describe('useAgentGrants', () => {
    it('should return empty grants when no data', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      const { result } = renderHook(() => useAgentGrants('agent-1'));

      expect(result.current.grants).toEqual([]);
    });

    it('should pass correct SWR key with agentId', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      renderHook(() => useAgentGrants('agent-1'));

      expect(mockUseSWR).toHaveBeenCalledWith(
        '/api/agents/agent-1/integrations',
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('should pass null key when agentId is null', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      renderHook(() => useAgentGrants(null));

      expect(mockUseSWR).toHaveBeenCalledWith(
        null,
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('should return grants when data is available', () => {
      const grants = [{ id: 'g-1', connectionId: 'c-1', agentId: 'a-1' }];
      mockUseSWR.mockReturnValue(createSWRResponse({ data: { grants } }));

      const { result } = renderHook(() => useAgentGrants('agent-1'));

      expect(result.current.grants).toEqual(grants);
    });
  });

  describe('useAvailableBuiltins', () => {
    it('should return empty builtins when no data', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      const { result } = renderHook(() => useAvailableBuiltins());

      expect(result.current.builtins).toEqual([]);
    });

    it('should pass correct SWR key', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      renderHook(() => useAvailableBuiltins());

      expect(mockUseSWR).toHaveBeenCalledWith(
        '/api/integrations/providers/available',
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('should return builtins when data is available', () => {
      const providers = [
        { id: 'b-1', name: 'Calendar', description: 'Google Calendar', documentationUrl: null },
      ];
      mockUseSWR.mockReturnValue(createSWRResponse({ data: { providers } }));

      const { result } = renderHook(() => useAvailableBuiltins());

      expect(result.current.builtins).toEqual(providers);
    });
  });

  describe('useConnectionGrantCount', () => {
    it('should return count 0 when no data', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      const { result } = renderHook(() => useConnectionGrantCount('conn-1'));

      expect(result.current.count).toBe(0);
    });

    it('should pass correct SWR key with connectionId', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      renderHook(() => useConnectionGrantCount('conn-1'));

      expect(mockUseSWR).toHaveBeenCalledWith(
        '/api/integrations/connections/conn-1/grants',
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('should pass null key when connectionId is null', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      renderHook(() => useConnectionGrantCount(null));

      expect(mockUseSWR).toHaveBeenCalledWith(
        null,
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('should return total count when data is available', () => {
      mockUseSWR.mockReturnValue(
        createSWRResponse({ data: { grants: [], total: 5 } })
      );

      const { result } = renderHook(() => useConnectionGrantCount('conn-1'));

      expect(result.current.count).toBe(5);
    });
  });

  describe('useGoogleCalendarStatus', () => {
    it('should return default values when no data', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      const { result } = renderHook(() => useGoogleCalendarStatus());

      expect(result.current.connected).toBe(false);
      expect(result.current.connection).toBeNull();
      expect(result.current.syncedEventCount).toBe(0);
    });

    it('should pass correct SWR key', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      renderHook(() => useGoogleCalendarStatus());

      expect(mockUseSWR).toHaveBeenCalledWith(
        '/api/integrations/google-calendar/status',
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('should return calendar status when data is available', () => {
      const data = {
        connected: true,
        connection: {
          status: 'active',
          googleEmail: 'user@example.com',
          lastSyncAt: '2024-01-01T00:00:00Z',
        },
        syncedEventCount: 42,
      };
      mockUseSWR.mockReturnValue(createSWRResponse({ data }));

      const { result } = renderHook(() => useGoogleCalendarStatus());

      expect(result.current.connected).toBe(true);
      expect(result.current.connection).toEqual(data.connection);
      expect(result.current.syncedEventCount).toBe(42);
    });
  });

  describe('useIntegrationAuditLogs', () => {
    it('should return empty logs when no data', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      const { result } = renderHook(() => useIntegrationAuditLogs('drive-1'));

      expect(result.current.logs).toEqual([]);
      expect(result.current.total).toBe(0);
    });

    it('should pass correct SWR key with driveId', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      renderHook(() => useIntegrationAuditLogs('drive-1'));

      expect(mockUseSWR).toHaveBeenCalledWith(
        '/api/drives/drive-1/integrations/audit',
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('should pass null key when driveId is null', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      renderHook(() => useIntegrationAuditLogs(null));

      expect(mockUseSWR).toHaveBeenCalledWith(
        null,
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('should include query params in SWR key when provided', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      renderHook(() =>
        useIntegrationAuditLogs('drive-1', {
          limit: 10,
          offset: 20,
          connectionId: 'conn-1',
          success: true,
          agentId: 'agent-1',
          dateFrom: '2024-01-01',
          dateTo: '2024-12-31',
          toolName: 'search',
        })
      );

      const swrKey = mockUseSWR.mock.calls[0][0];
      expect(swrKey).toContain('/api/drives/drive-1/integrations/audit?');
      expect(swrKey).toContain('limit=10');
      expect(swrKey).toContain('offset=20');
      expect(swrKey).toContain('connectionId=conn-1');
      expect(swrKey).toContain('success=true');
      expect(swrKey).toContain('agentId=agent-1');
      expect(swrKey).toContain('dateFrom=2024-01-01');
      expect(swrKey).toContain('dateTo=2024-12-31');
      expect(swrKey).toContain('toolName=search');
    });

    it('should not include query params that are not provided', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      renderHook(() =>
        useIntegrationAuditLogs('drive-1', { limit: 10 })
      );

      const swrKey = mockUseSWR.mock.calls[0][0] as string;
      expect(swrKey).toContain('limit=10');
      expect(swrKey).not.toContain('offset=');
      expect(swrKey).not.toContain('connectionId=');
    });

    it('should return logs and total when data is available', () => {
      const data = {
        logs: [
          { id: 'l-1', toolName: 'search', success: true },
          { id: 'l-2', toolName: 'read', success: false },
        ],
        total: 100,
      };
      mockUseSWR.mockReturnValue(createSWRResponse({ data }));

      const { result } = renderHook(() => useIntegrationAuditLogs('drive-1'));

      expect(result.current.logs).toEqual(data.logs);
      expect(result.current.total).toBe(100);
    });

    it('should not append query string when no params are provided', () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      renderHook(() => useIntegrationAuditLogs('drive-1'));

      const swrKey = mockUseSWR.mock.calls[0][0] as string;
      expect(swrKey).toBe('/api/drives/drive-1/integrations/audit');
      expect(swrKey).not.toContain('?');
    });
  });

  describe('SWR fetcher', () => {
    it('should use fetchWithAuth and throw on non-ok response', async () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      renderHook(() => useProviders());

      const fetcher = mockUseSWR.mock.calls[0][1];

      mockFetchWithAuth.mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue('Internal Server Error'),
      });

      await expect(fetcher('/api/integrations/providers')).rejects.toThrow(
        /Failed to fetch/
      );
    });

    it('should return parsed JSON on successful response', async () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      renderHook(() => useProviders());

      const fetcher = mockUseSWR.mock.calls[0][1];
      const mockData = { providers: [] };

      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockData),
      });

      const result = await fetcher('/api/integrations/providers');
      expect(result).toEqual(mockData);
    });

    it('should include sanitized error body in error message', async () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      renderHook(() => useProviders());

      const fetcher = mockUseSWR.mock.calls[0][1];

      mockFetchWithAuth.mockResolvedValue({
        ok: false,
        status: 403,
        text: vi.fn().mockResolvedValue('Forbidden: Access denied'),
      });

      await expect(fetcher('/api/integrations/providers')).rejects.toThrow(
        /403.*Forbidden: Access denied/
      );
    });

    it('should handle text() failure gracefully', async () => {
      mockUseSWR.mockReturnValue(createSWRResponse());

      renderHook(() => useProviders());

      const fetcher = mockUseSWR.mock.calls[0][1];

      mockFetchWithAuth.mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockRejectedValue(new Error('text failed')),
      });

      await expect(fetcher('/api/integrations/providers')).rejects.toThrow(
        /Failed to fetch.*500/
      );
    });
  });
});
