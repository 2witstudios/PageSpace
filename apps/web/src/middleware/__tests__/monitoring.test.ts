/**
 * Tests for the edge-safe monitoring middleware.
 *
 * The middleware must never touch the database (the old MetricsCollector was
 * deleted for exactly that reason) — its only persistence path is the
 * fire-and-forget fetch POST to /api/internal/monitoring/ingest. These tests
 * pin that contract: ingest forwarding for /api requests, response headers,
 * the error-path re-throw, and the module's edge purity.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';

// Mock the edge logger to keep test output clean; behavior under test is the
// middleware's, not the logger's (which has its own test file).
vi.mock('@/lib/logging/edge-logger', () => ({
  createEdgeLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock request-id (has transitive dep on @paralleldrive/cuid2)
vi.mock('@/lib/request-id/request-id', () => ({
  getOrCreateRequestId: vi.fn(() => 'test-request-id'),
  REQUEST_ID_HEADER: 'X-Request-Id',
}));

import { getMonitoringIngestStatus, monitoringMiddleware } from '../monitoring';

describe('getMonitoringIngestStatus', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.MONITORING_INGEST_KEY;
    delete process.env.MONITORING_INGEST_DISABLED;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('given MONITORING_INGEST_KEY is set, should return active', () => {
    process.env.MONITORING_INGEST_KEY = 'test-key-abc123';
    expect(getMonitoringIngestStatus()).toBe('active');
  });

  it('given MONITORING_INGEST_DISABLED is true, should return disabled', () => {
    process.env.MONITORING_INGEST_DISABLED = 'true';
    expect(getMonitoringIngestStatus()).toBe('disabled');
  });

  it('given MONITORING_INGEST_DISABLED is true with key also set, should return disabled', () => {
    process.env.MONITORING_INGEST_KEY = 'test-key-abc123';
    process.env.MONITORING_INGEST_DISABLED = 'true';
    expect(getMonitoringIngestStatus()).toBe('disabled');
  });

  it('given no key and no opt-out, should return misconfigured', () => {
    expect(getMonitoringIngestStatus()).toBe('misconfigured');
  });

  it('given MONITORING_INGEST_DISABLED is false, should not count as disabled', () => {
    process.env.MONITORING_INGEST_DISABLED = 'false';
    expect(getMonitoringIngestStatus()).toBe('misconfigured');
  });
});

describe('monitoringMiddleware', () => {
  const originalEnv = process.env;
  let fetchMock: ReturnType<typeof vi.fn>;

  const buildRequest = (pathname: string, headers: Record<string, string> = {}) =>
    new NextRequest(new URL(`http://localhost${pathname}`), { headers });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.MONITORING_INGEST_KEY = 'test-key';
    delete process.env.MONITORING_INGEST_DISABLED;
    delete process.env.MONITORING_INGEST_PATH;
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('forwards an api-request payload to the ingest route for /api requests', async () => {
    const request = buildRequest('/api/pages/xyz', {
      'x-user-id': 'user-1',
      'user-agent': 'test-agent',
      'x-forwarded-for': '10.0.0.1',
    });

    const response = await monitoringMiddleware(request, async () =>
      NextResponse.json({ ok: true }, { status: 200 })
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost/api/internal/monitoring/ingest');
    expect(init.method).toBe('POST');
    expect(init.headers['x-monitoring-ingest-key']).toBe('test-key');
    const payload = JSON.parse(init.body);
    expect(payload).toMatchObject({
      type: 'api-request',
      requestId: 'test-request-id',
      method: 'GET',
      endpoint: '/api/pages/xyz',
      statusCode: 200,
      userId: 'user-1',
      ip: '10.0.0.1',
      userAgent: 'test-agent',
    });
    expect(typeof payload.duration).toBe('number');
  });

  it('does not POST to ingest for non-API page requests', async () => {
    const response = await monitoringMiddleware(buildRequest('/dashboard'), async () =>
      NextResponse.json({ ok: true })
    );

    expect(response).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not POST to ingest when the key is missing (misconfigured)', async () => {
    delete process.env.MONITORING_INGEST_KEY;

    await monitoringMiddleware(buildRequest('/api/pages/xyz'), async () =>
      NextResponse.json({ ok: true })
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips monitoring entirely for static assets and the ingest route itself', async () => {
    for (const pathname of ['/_next/static/chunk.js', '/favicon.ico', '/api/internal/monitoring/ingest']) {
      const next = vi.fn(async () => NextResponse.json({ ok: true }));
      const response = await monitoringMiddleware(buildRequest(pathname), next);
      expect(next).toHaveBeenCalledTimes(1);
      // No monitoring headers on skipped paths
      expect(response.headers.get('X-Response-Time')).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sets request-id and X-Response-Time headers on monitored responses', async () => {
    const response = await monitoringMiddleware(buildRequest('/api/health'), async () =>
      NextResponse.json({ ok: true })
    );

    expect(response.headers.get('X-Request-Id')).toBe('test-request-id');
    expect(response.headers.get('X-Response-Time')).toMatch(/^\d+ms$/);
  });

  it('strips query strings from the ingested endpoint', async () => {
    await monitoringMiddleware(buildRequest('/api/search?q=secret'), async () =>
      NextResponse.json({ ok: true })
    );

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.endpoint).toBe('/api/search');
  });

  it('re-throws handler errors after forwarding a statusCode-500 payload', async () => {
    const boom = new Error('handler exploded');

    await expect(
      monitoringMiddleware(buildRequest('/api/pages/xyz'), async () => {
        throw boom;
      })
    ).rejects.toThrow('handler exploded');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).toMatchObject({
      statusCode: 500,
      error: 'handler exploded',
      errorName: 'Error',
    });
  });

  it('registers the ingest POST with event.waitUntil so the Edge runtime cannot cancel it', async () => {
    const waitUntil = vi.fn();
    const event = { waitUntil } as unknown as import('next/server').NextFetchEvent;

    await monitoringMiddleware(
      buildRequest('/api/pages/xyz'),
      async () => NextResponse.json({ ok: true }),
      event
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });

  it('registers the error-path ingest POST with event.waitUntil too', async () => {
    const waitUntil = vi.fn();
    const event = { waitUntil } as unknown as import('next/server').NextFetchEvent;

    await expect(
      monitoringMiddleware(buildRequest('/api/pages/xyz'), async () => {
        throw new Error('boom');
      }, event)
    ).rejects.toThrow('boom');

    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('survives an ingest fetch rejection without failing the request', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const response = await monitoringMiddleware(buildRequest('/api/health'), async () =>
      NextResponse.json({ ok: true })
    );

    expect(response.status).toBe(200);
  });
});

describe('module edge purity (acceptance criterion)', () => {
  it('never imports @pagespace/db, @pagespace/lib, or Node built-ins', () => {
    // Strip comments first — the doc header legitimately names the modules
    // this file must NOT import.
    const source = fs
      .readFileSync(path.resolve(__dirname, '../monitoring.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(source).not.toMatch(/@pagespace\//);
    expect(source).not.toMatch(/from\s+['"](os|fs|net|tls|crypto)['"]/);
    expect(source).not.toMatch(/setInterval/);
    expect(source).not.toMatch(/\bMetricsCollector\b/);
  });
});
