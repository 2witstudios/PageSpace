/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Contract Tests for /api/monitoring/[metric]
//
// Tests admin-only monitoring data endpoints for various metric types.
// The route exports `GET = withAdminAuth(handler)`. We mock withAdminAuth
// as a pass-through, so GET becomes the raw handler accepting (adminUser, request, context).
// ============================================================================

vi.mock('@/lib/auth', () => ({
  // Pass-through: withAdminAuth returns the handler as-is
  withAdminAuth: vi.fn((handler: any) => handler),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/lib/monitoring', () => ({
  getSystemHealth: vi.fn(),
  getApiMetrics: vi.fn(),
  getUserActivity: vi.fn(),
  getAiUsageMetrics: vi.fn(),
  getErrorAnalytics: vi.fn(),
  getPerformanceMetrics: vi.fn(),
  getDateRange: vi.fn(),
}));

import { GET } from '../route';
import {
  getSystemHealth,
  getApiMetrics,
  getUserActivity,
  getAiUsageMetrics,
  getErrorAnalytics,
  getPerformanceMetrics,
  getDateRange,
} from '@/lib/monitoring';

// ============================================================================
// Test Helpers
// ============================================================================

const MOCK_ADMIN_USER = {
  id: 'admin_1',
  role: 'admin' as const,
  tokenVersion: 0,
  adminRoleVersion: 0,
  authTransport: 'cookie' as const,
};

const MOCK_DATE_RANGE = {
  startDate: new Date('2024-01-01'),
  endDate: new Date('2024-01-02'),
};

// Since withAdminAuth is a pass-through, GET is the raw handler:
// (adminUser, request, context) => Promise<Response>
const callHandler = (metric: string, queryString = '') => {
  const url = `http://localhost/api/monitoring/${metric}${queryString}`;
  const request = new Request(url);
  const context = { params: Promise.resolve({ metric }) };
  return (GET as any)(MOCK_ADMIN_USER, request, context);
};

// ============================================================================
// GET /api/monitoring/[metric] - Contract Tests
// ============================================================================

describe('GET /api/monitoring/[metric]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDateRange).mockReturnValue(MOCK_DATE_RANGE);
  });

  it('should export GET as a function', () => {
    expect(GET).toBeDefined();
    expect(typeof GET).toBe('function');
  });

  describe('metric: system-health', () => {
    it('should return system health data', async () => {
      const mockData = { uptime: 99.9, memory: 'ok' };
      vi.mocked(getSystemHealth).mockResolvedValue(mockData as any);

      const response = await callHandler('system-health');
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data).toEqual(mockData);
      expect(body.range).toBe('24h');
    });
  });

  describe('metric: api-metrics', () => {
    it('should return API metrics data', async () => {
      const mockData = { totalRequests: 1000 };
      vi.mocked(getApiMetrics).mockResolvedValue(mockData as any);

      const response = await callHandler('api-metrics');
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data).toEqual(mockData);
    });
  });

  describe('metric: user-activity', () => {
    it('should return user activity data', async () => {
      const mockData = { activeUsers: 42 };
      vi.mocked(getUserActivity).mockResolvedValue(mockData as any);

      const response = await callHandler('user-activity');
      const body = await response.json();

      expect(body.data).toEqual(mockData);
    });
  });

  describe('metric: ai-usage', () => {
    it('should return AI usage metrics', async () => {
      const mockData = { totalTokens: 50000 };
      vi.mocked(getAiUsageMetrics).mockResolvedValue(mockData as any);

      const response = await callHandler('ai-usage');
      const body = await response.json();

      expect(body.data).toEqual(mockData);
    });
  });

  describe('metric: error-logs', () => {
    it('should return error analytics data', async () => {
      const mockData = { totalErrors: 5 };
      vi.mocked(getErrorAnalytics).mockResolvedValue(mockData as any);

      const response = await callHandler('error-logs');
      const body = await response.json();

      expect(body.data).toEqual(mockData);
    });
  });

  describe('metric: performance', () => {
    it('should return performance metrics', async () => {
      const mockData = { avgResponseTime: 150 };
      vi.mocked(getPerformanceMetrics).mockResolvedValue(mockData as any);

      const response = await callHandler('performance');
      const body = await response.json();

      expect(body.data).toEqual(mockData);
    });
  });

  describe('invalid metric', () => {
    it('should return 400 for unknown metric type', async () => {
      const response = await callHandler('unknown-metric');
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid metric type');
    });
  });

  describe('range parameter', () => {
    it('should use the range query parameter', async () => {
      vi.mocked(getSystemHealth).mockResolvedValue({} as any);

      const response = await callHandler('system-health', '?range=7d');
      const body = await response.json();

      expect(getDateRange).toHaveBeenCalledWith('7d');
      expect(body.range).toBe('7d');
    });

    it('should default to 24h when range is not specified', async () => {
      vi.mocked(getSystemHealth).mockResolvedValue({} as any);

      await callHandler('system-health');

      expect(getDateRange).toHaveBeenCalledWith('24h');
    });
  });

  describe('response shape', () => {
    it('should include data, range, startDate, and endDate', async () => {
      vi.mocked(getSystemHealth).mockResolvedValue({ status: 'ok' } as any);

      const response = await callHandler('system-health');
      const body = await response.json();

      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('range');
      expect(body).toHaveProperty('startDate');
      expect(body).toHaveProperty('endDate');
    });
  });

  describe('error handling', () => {
    it('should return 500 when metric query throws', async () => {
      vi.mocked(getSystemHealth).mockRejectedValue(new Error('DB error'));

      const response = await callHandler('system-health');
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch monitoring data');
    });
  });
});
