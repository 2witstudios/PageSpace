/**
 * Edge-logger tests: output shape (parseable JSON matching the Node logger's
 * field names), level routing, LOG_LEVEL filtering, error serialization, and
 * the module-purity acceptance criterion (imports only from itself/types).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createEdgeLogger, logSecurityEvent, type EdgeLogEntry } from '../edge-logger';

const parseOnlyCall = (spy: ReturnType<typeof vi.fn>): EdgeLogEntry => {
  expect(spy).toHaveBeenCalledTimes(1);
  const line = spy.mock.calls[0][0] as string;
  return JSON.parse(line) as EdgeLogEntry;
};

describe('edge-logger', () => {
  const originalEnv = process.env;
  let logSpy: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LOG_LEVEL;
    logSpy = vi.fn();
    warnSpy = vi.fn();
    errorSpy = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(logSpy);
    vi.spyOn(console, 'warn').mockImplementation(warnSpy);
    vi.spyOn(console, 'error').mockImplementation(errorSpy);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('output shape', () => {
    it('emits single-line JSON with timestamp, level, category, message, metadata', () => {
      const log = createEdgeLogger('api');
      log.info('GET /api/health 200 12ms', { requestId: 'req-1', statusCode: 200 });

      const entry = parseOnlyCall(logSpy);
      expect(entry).toEqual({
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        level: 'INFO',
        category: 'api',
        message: 'GET /api/health 200 12ms',
        metadata: { requestId: 'req-1', statusCode: 200 },
      });
    });

    it('omits the metadata key entirely when no metadata is given', () => {
      createEdgeLogger('system').info('startup');
      const entry = parseOnlyCall(logSpy);
      expect('metadata' in entry).toBe(false);
    });

    it('routes warn to console.warn and error to console.error (matching the Node logger)', () => {
      const log = createEdgeLogger('api');
      log.warn('slow request');
      log.error('request failed');

      expect(parseOnlyCall(warnSpy).level).toBe('WARN');
      expect(parseOnlyCall(errorSpy).level).toBe('ERROR');
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('serializes an Error into metadata.error (Errors otherwise stringify to {})', () => {
      const boom = new Error('kaboom');
      createEdgeLogger('api').error('Request failed', boom, { requestId: 'req-9' });

      const entry = parseOnlyCall(errorSpy);
      expect(entry.metadata).toMatchObject({
        requestId: 'req-9',
        error: { name: 'Error', message: 'kaboom', stack: expect.stringContaining('kaboom') },
      });
    });
  });

  describe('LOG_LEVEL filtering', () => {
    it('suppresses debug by default (info threshold)', () => {
      createEdgeLogger('auth').debug('noisy');
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('emits debug when LOG_LEVEL=debug', () => {
      process.env.LOG_LEVEL = 'debug';
      createEdgeLogger('auth').debug('now visible');
      expect(parseOnlyCall(logSpy).level).toBe('DEBUG');
    });

    it('suppresses info when LOG_LEVEL=error but still emits error', () => {
      process.env.LOG_LEVEL = 'error';
      const log = createEdgeLogger('api');
      log.info('hidden');
      log.error('shown');
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('suppresses everything when LOG_LEVEL=silent', () => {
      process.env.LOG_LEVEL = 'silent';
      const log = createEdgeLogger('api');
      log.error('even errors');
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('logSecurityEvent', () => {
    it('warns with category security and the same message format as the Node logger', () => {
      logSecurityEvent('unauthorized', { pathname: '/dashboard', reason: 'No session token', ip: '1.2.3.4' });

      const entry = parseOnlyCall(warnSpy);
      expect(entry.level).toBe('WARN');
      expect(entry.category).toBe('security');
      expect(entry.message).toBe('Security event: unauthorized');
      expect(entry.metadata).toEqual({ pathname: '/dashboard', reason: 'No session token', ip: '1.2.3.4' });
    });
  });

  describe('module purity (acceptance criterion)', () => {
    it('imports nothing — no Node built-ins, no @pagespace/*, no db, no dynamic imports, no process.on', () => {
      // Strip comments first — the doc header legitimately names the modules
      // this file must NOT import.
      const source = fs
        .readFileSync(path.resolve(__dirname, '../edge-logger.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(source).not.toMatch(/^import\s/m); // zero import statements
      expect(source).not.toMatch(/\brequire\s*\(/);
      expect(source).not.toMatch(/\bimport\s*\(/); // dynamic import
      expect(source).not.toMatch(/@pagespace\//);
      expect(source).not.toMatch(/from\s+['"]os['"]/);
      expect(source).not.toMatch(/process\.on\b/);
      expect(source).not.toMatch(/setInterval|setTimeout/);
    });
  });
});
