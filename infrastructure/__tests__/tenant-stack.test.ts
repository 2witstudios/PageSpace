import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, accessSync, constants } from 'fs';
import { resolve } from 'path';

const SCRIPT = resolve(__dirname, '../scripts/tenant-stack.sh');

function runScript(args: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args.split(' ').filter(Boolean)], {
      encoding: 'utf-8',
      timeout: 5_000,
      env: { ...process.env, DRY_RUN: '1' },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('tenant-stack.sh', () => {
  describe('file properties', () => {
    it('given the script, should exist', () => {
      expect(() => accessSync(SCRIPT)).not.toThrow();
    });

    it('given the script, should be executable', () => {
      expect(() => accessSync(SCRIPT, constants.X_OK)).not.toThrow();
    });
  });

  describe('command parsing', () => {
    it('given no arguments, should exit with code 1', () => {
      const { code } = runScript('');
      expect(code).toBe(1);
    });

    it('given an unknown command, should exit with code 1', () => {
      const { code } = runScript('frobnicate test-tenant');
      expect(code).toBe(1);
    });

    it('given a command but no slug, should exit with code 1', () => {
      const { code } = runScript('up');
      expect(code).toBe(1);
    });
  });

  describe('slug validation', () => {
    it('given a slug with special characters, should exit with code 1', () => {
      const { code } = runScript('up bad!slug');
      expect(code).toBe(1);
    });

    it('given a slug with uppercase, should exit with code 1', () => {
      const { code } = runScript('up BadSlug');
      expect(code).toBe(1);
    });
  });

  describe('script content', () => {
    const content = readFileSync(SCRIPT, 'utf-8');

    it('given the script, should reference docker compose with project name prefix ps-', () => {
      expect(content).toContain('docker compose -p');
      expect(content).toMatch(/ps-/);
    });

    it('given the script, should reference docker-compose.tenant.yml', () => {
      expect(content).toContain('docker-compose.tenant.yml');
    });

    it('given the script, should use --env-file flag', () => {
      expect(content).toContain('--env-file');
    });
  });
});
