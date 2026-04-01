import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';

const COMPOSE_PATH = resolve(__dirname, '../docker-compose.tenant.yml');

interface LoggingConfig {
  driver?: string;
  options?: Record<string, string>;
}

interface ComposeService {
  logging?: LoggingConfig;
  [key: string]: unknown;
}

interface ComposeFile {
  services: Record<string, ComposeService>;
}

function loadCompose(): ComposeFile {
  const raw = readFileSync(COMPOSE_PATH, 'utf-8');
  return parse(raw) as ComposeFile;
}

describe('Tenant logging configuration', () => {
  const compose = loadCompose();

  // Long-running services that produce ongoing logs
  const longRunningServices = [
    'postgres',
    'redis',
    'redis-sessions',
    'processor',
    'web',
    'realtime',
    'cron',
  ];

  describe('log driver', () => {
    it.each(longRunningServices)(
      'given the %s service, should use json-file log driver',
      (svc) => {
        const logging = compose.services[svc].logging;
        expect(logging).toBeDefined();
        expect(logging!.driver).toBe('json-file');
      },
    );
  });

  describe('log rotation', () => {
    it.each(longRunningServices)(
      'given the %s service, should limit log size to 10m',
      (svc) => {
        const options = compose.services[svc].logging?.options;
        expect(options).toBeDefined();
        expect(options!['max-size']).toBe('10m');
      },
    );

    it.each(longRunningServices)(
      'given the %s service, should keep at most 3 log files',
      (svc) => {
        const options = compose.services[svc].logging?.options;
        expect(options).toBeDefined();
        expect(options!['max-file']).toBe('3');
      },
    );
  });
});
