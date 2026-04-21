import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

const SCRIPT = resolve(__dirname, '../scripts/generate-tenant-env.sh');

function runScript(args: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args.split(' ').filter(Boolean)], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function parseEnv(stdout: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    entries.set(trimmed.substring(0, eqIdx), trimmed.substring(eqIdx + 1));
  }
  return entries;
}

describe('generate-tenant-env.sh', () => {
  describe('validation', () => {
    it('given no slug argument, should exit with code 1', () => {
      const { code } = runScript('');
      expect(code).toBe(1);
    });

    it('given an invalid slug with uppercase, should exit with code 1', () => {
      const { code } = runScript('MyTenant');
      expect(code).toBe(1);
    });

    it('given an invalid slug with special characters, should exit with code 1', () => {
      const { code } = runScript('my_tenant!');
      expect(code).toBe(1);
    });

    it('given a slug starting with a hyphen, should exit with code 1', () => {
      const { code } = runScript('-bad-slug');
      expect(code).toBe(1);
    });
  });

  describe('output completeness', () => {
    const result = runScript('test-tenant');
    const env = parseEnv(result.stdout);

    it('given valid slug, should exit with code 0', () => {
      expect(result.code).toBe(0);
    });

    it('given valid slug, output should not contain __GENERATE__', () => {
      expect(result.stdout).not.toContain('__GENERATE__');
    });

    it('given valid slug, output should not contain __SET_BY_PROVISIONER__', () => {
      expect(result.stdout).not.toContain('__SET_BY_PROVISIONER__');
    });

    it('given slug test-tenant, TENANT_SLUG should match', () => {
      expect(env.get('TENANT_SLUG')).toBe('test-tenant');
    });

    it('given slug test-tenant, WEB_APP_URL should be https://test-tenant.pagespace.ai', () => {
      expect(env.get('WEB_APP_URL')).toBe('https://test-tenant.pagespace.ai');
    });

    it('given slug test-tenant, CORS_ORIGIN should be https://test-tenant.pagespace.ai', () => {
      expect(env.get('CORS_ORIGIN')).toBe('https://test-tenant.pagespace.ai');
    });

    it('given slug test-tenant, NEXT_PUBLIC_APP_URL should be https://test-tenant.pagespace.ai', () => {
      expect(env.get('NEXT_PUBLIC_APP_URL')).toBe('https://test-tenant.pagespace.ai');
    });

    it('given the output, DEPLOYMENT_MODE should be tenant', () => {
      expect(env.get('DEPLOYMENT_MODE')).toBe('tenant');
    });
  });

  describe('secret generation', () => {
    const result = runScript('secret-test');
    const env = parseEnv(result.stdout);

    it('given ENCRYPTION_KEY, should be 64 hex characters', () => {
      expect(env.get('ENCRYPTION_KEY')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('given CSRF_SECRET, should be 64 hex characters', () => {
      expect(env.get('CSRF_SECRET')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('given POSTGRES_PASSWORD, should be at least 24 alphanumeric characters', () => {
      const val = env.get('POSTGRES_PASSWORD') ?? '';
      expect(val.length).toBeGreaterThanOrEqual(24);
      expect(val).toMatch(/^[a-zA-Z0-9]+$/);
    });

    it('given all secrets, should all be unique (no reuse)', () => {
      const secrets = [
        env.get('ENCRYPTION_KEY'),
        env.get('CSRF_SECRET'),
        env.get('POSTGRES_PASSWORD'),
        env.get('CRON_SECRET'),
        env.get('REALTIME_BROADCAST_SECRET'),
      ];
      const unique = new Set(secrets);
      expect(unique.size).toBe(secrets.length);
    });

    const removedSecrets = ['REDIS_PASSWORD', 'JWT_SECRET', 'JWT_ISSUER', 'JWT_AUDIENCE'];
    it.each(removedSecrets)(
      'given the output, should NOT emit %s (vestigial after Redis + JWT deprecation)',
      (key) => {
        expect(env.has(key)).toBe(false);
      },
    );
  });

  describe('uniqueness across runs', () => {
    it('given two runs, should produce different ENCRYPTION_KEY values', () => {
      const env1 = parseEnv(runScript('unique-test').stdout);
      const env2 = parseEnv(runScript('unique-test').stdout);
      expect(env1.get('ENCRYPTION_KEY')).not.toBe(env2.get('ENCRYPTION_KEY'));
    });
  });

  describe('--image-tag flag', () => {
    it('given --image-tag v1.2.3, IMAGE_TAG should be v1.2.3', () => {
      const result = runScript('tag-test --image-tag v1.2.3');
      const env = parseEnv(result.stdout);
      expect(env.get('IMAGE_TAG')).toBe('v1.2.3');
    });
  });
});
