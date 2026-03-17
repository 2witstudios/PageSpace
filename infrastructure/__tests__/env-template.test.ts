import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const COMPOSE_PATH = resolve(__dirname, '../docker-compose.tenant.yml');
const TEMPLATE_PATH = resolve(__dirname, '../env.tenant.template');

function extractComposeVars(): Set<string> {
  const raw = readFileSync(COMPOSE_PATH, 'utf-8');
  const vars = new Set<string>();
  const re = /\$\{([A-Z_][A-Z0-9_]*)(?::-[^}]*)?\}/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    vars.add(match[1]);
  }
  return vars;
}

function parseTemplate(): Map<string, string> {
  const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
  const entries = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx);
    const value = trimmed.substring(eqIdx + 1);
    entries.set(key, value);
  }
  return entries;
}

describe('Tenant env template', () => {
  const composeVars = extractComposeVars();
  const templateVars = parseTemplate();

  it('given the compose file variables, every ${VAR} should have a template entry', () => {
    const missing: string[] = [];
    for (const v of composeVars) {
      if (!templateVars.has(v)) {
        missing.push(v);
      }
    }
    expect(missing).toEqual([]);
  });

  const secretVars = [
    'ENCRYPTION_KEY',
    'CSRF_SECRET',
    'JWT_SECRET',
    'REDIS_PASSWORD',
    'POSTGRES_PASSWORD',
    'CRON_SECRET',
    'REALTIME_BROADCAST_SECRET',
  ];

  it.each(secretVars)(
    'given the %s secret, should be marked __GENERATE__',
    (v) => {
      expect(templateVars.get(v)).toBe('__GENERATE__');
    },
  );

  it('given __GENERATE__ entries, none should have empty placeholder values', () => {
    for (const [key, value] of templateVars) {
      if (value === '__GENERATE__') {
        expect(value).not.toBe('');
        expect(key).toBeTruthy();
      }
    }
  });

  it('given DEPLOYMENT_MODE, should default to tenant', () => {
    expect(templateVars.get('DEPLOYMENT_MODE')).toBe('tenant');
  });

  it('given IMAGE_TAG, should default to latest', () => {
    expect(templateVars.get('IMAGE_TAG')).toBe('latest');
  });
});
