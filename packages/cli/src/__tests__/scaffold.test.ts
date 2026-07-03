import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLI_VERSION } from '@pagespace/cli';

interface PackageManifest {
  name?: string;
  bin?: Record<string, string>;
  exports?: unknown;
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'),
) as PackageManifest;

const SEMVER = /^\d+\.\d+\.\d+$/;

describe('@pagespace/cli package scaffold', () => {
  it('is named @pagespace/cli', () => {
    expect(packageJson.name).toBe('@pagespace/cli');
  });

  it('declares the pagespace bin pointing at dist/bin.js', () => {
    expect(packageJson.bin).toEqual({ pagespace: './dist/bin.js' });
  });

  it('ships an exports map for programmatic (non-bin) consumers', () => {
    expect(packageJson.exports).toBeDefined();
  });

  it('only ships dist/ in the published package', () => {
    expect(packageJson.files).toEqual(['dist']);
  });

  it('depends on @pagespace/sdk as a workspace dependency', () => {
    expect(packageJson.dependencies).toMatchObject({ '@pagespace/sdk': 'workspace:*' });
  });

  it('declares build, typecheck, and test scripts for turbo/bun --filter', () => {
    expect(packageJson.scripts).toMatchObject({
      build: expect.any(String),
      typecheck: expect.any(String),
      test: expect.any(String),
    });
  });

  it('is importable by its published package name and exports a semver CLI_VERSION', () => {
    expect(typeof CLI_VERSION).toBe('string');
    expect(CLI_VERSION).toMatch(SEMVER);
  });
});
