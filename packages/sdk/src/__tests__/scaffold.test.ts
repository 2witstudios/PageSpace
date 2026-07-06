import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MIN_SERVER_API_VERSION, SDK_VERSION } from '@pagespace/sdk';

interface PackageManifest {
  scripts?: Record<string, string>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'),
) as PackageManifest;

const SEMVER = /^\d+\.\d+\.\d+$/;

describe('@pagespace/sdk package scaffold', () => {
  it('is importable by its published package name and exports a semver SDK_VERSION', () => {
    expect(typeof SDK_VERSION).toBe('string');
    expect(SDK_VERSION).toMatch(SEMVER);
  });

  it('reserves a semver MIN_SERVER_API_VERSION per ADR 0001 D3', () => {
    expect(typeof MIN_SERVER_API_VERSION).toBe('string');
    expect(MIN_SERVER_API_VERSION).toMatch(SEMVER);
  });

  it('declares build, typecheck, and test scripts for turbo/bun --filter', () => {
    expect(packageJson.scripts).toMatchObject({
      build: expect.any(String),
      typecheck: expect.any(String),
      test: expect.any(String),
    });
  });
});
