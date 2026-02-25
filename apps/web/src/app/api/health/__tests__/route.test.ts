import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '../route';
const mockExecute = vi.hoisted(() => vi.fn());
const mockGetMonitoringIngestStatus = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/db', () => ({
  db: {
    execute: mockExecute,
  },
  sql: (strings: TemplateStringsArray) => strings.join(''),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

vi.mock('@/middleware/monitoring', () => ({
  getMonitoringIngestStatus: mockGetMonitoringIngestStatus,
}));

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMonitoringIngestStatus.mockReturnValue('active');
  });

  describe('healthy system', () => {
    it('given database is connected, should return healthy status', async () => {
      mockExecute.mockResolvedValue([{ '1': 1 }]);

      const request = new Request('https://example.com/api/health', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.status).toBe('healthy');
      expect(body.checks.database).toBe('connected');
    });

    it('given healthy state, should include timestamp', async () => {
      mockExecute.mockResolvedValue([{ '1': 1 }]);

      const request = new Request('https://example.com/api/health', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(body.timestamp).toBeDefined();
      expect(new Date(body.timestamp).getTime()).not.toBeNaN();
    });

    it('given healthy state, should include service info', async () => {
      mockExecute.mockResolvedValue([{ '1': 1 }]);

      const request = new Request('https://example.com/api/health', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(body.service).toBe('pagespace-web');
      expect(body.version).toBeDefined();
    });

    it('given healthy state, should include memory usage', async () => {
      mockExecute.mockResolvedValue([{ '1': 1 }]);

      const request = new Request('https://example.com/api/health', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(body.memory).toBeDefined();
      expect(typeof body.memory.heapUsed).toBe('number');
      expect(typeof body.memory.heapTotal).toBe('number');
    });
  });

  describe('database failures', () => {
    it('given database connection fails, should return degraded status', async () => {
      mockExecute.mockRejectedValue(new Error('Connection refused'));

      const request = new Request('https://example.com/api/health', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.status).toBe('degraded');
      expect(body.checks.database).toBe('disconnected');
    });

    it('given database timeout, should return degraded with error details', async () => {
      mockExecute.mockRejectedValue(new Error('Query timeout'));

      const request = new Request('https://example.com/api/health', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.status).toBe('degraded');
      expect(body.error).toContain('Database');
    });
  });

  describe('monitoring status', () => {
    it('given monitoring is active, should report healthy with monitoring active', async () => {
      mockExecute.mockResolvedValue([{ '1': 1 }]);
      mockGetMonitoringIngestStatus.mockReturnValue('active');

      const request = new Request('https://example.com/api/health', { method: 'GET' });
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.status).toBe('healthy');
      expect(body.checks.monitoring).toBe('active');
      expect(body.warnings).toBeUndefined();
    });

    it('given monitoring is explicitly disabled, should report healthy', async () => {
      mockExecute.mockResolvedValue([{ '1': 1 }]);
      mockGetMonitoringIngestStatus.mockReturnValue('disabled');

      const request = new Request('https://example.com/api/health', { method: 'GET' });
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.status).toBe('healthy');
      expect(body.checks.monitoring).toBe('disabled');
    });

    it('given monitoring is misconfigured, should report degraded with warning', async () => {
      mockExecute.mockResolvedValue([{ '1': 1 }]);
      mockGetMonitoringIngestStatus.mockReturnValue('misconfigured');

      const request = new Request('https://example.com/api/health', { method: 'GET' });
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.status).toBe('degraded');
      expect(body.checks.monitoring).toBe('misconfigured');
      expect(body.warnings).toBeDefined();
      expect(body.warnings[0]).toContain('MONITORING_INGEST_KEY');
    });
  });

  describe('caching headers', () => {
    it('should not cache health check responses', async () => {
      mockExecute.mockResolvedValue([{ '1': 1 }]);

      const request = new Request('https://example.com/api/health', {
        method: 'GET',
      });

      const response = await GET(request);

      expect(response.headers.get('Cache-Control')).toBe(
        'no-store, no-cache, must-revalidate'
      );
    });
  });
});
