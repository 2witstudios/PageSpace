/**
 * ADR 0001 D3 (docs/adr/0001-sdk-api-versioning.md) — the SDK pins its own
 * MIN_SERVER_API_VERSION and never imports the server's live
 * API_CONTRACT_VERSION. This guards both halves of that decision: the
 * SDK's floor must never demand a future server, and the SDK source must
 * stay decoupled from the server tree it will be published independently
 * of.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { API_CONTRACT_VERSION } from '@pagespace/lib/api-contract-version';
import { MIN_SERVER_API_VERSION, compareApiVersions, parseApiVersion } from '../version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '..');

function listNonTestSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listNonTestSourceFiles(full);
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) return [full];
    return [];
  });
}

describe('ADR 0001 D3 — SDK/server version decoupling', () => {
  it('D7.11 — MIN_SERVER_API_VERSION never exceeds API_CONTRACT_VERSION', () => {
    const min = parseApiVersion(MIN_SERVER_API_VERSION);
    const contract = parseApiVersion(API_CONTRACT_VERSION);
    expect(min).not.toBeNull();
    expect(contract).not.toBeNull();
    expect(compareApiVersions(min!, contract!)).toBeLessThanOrEqual(0);
  });

  it('the SDK source never imports the server\'s api-contract-version module (D3: decoupled from @pagespace/lib)', () => {
    const offenders = listNonTestSourceFiles(SRC_ROOT).filter((file) => {
      const content = readFileSync(file, 'utf-8');
      return /from\s+['"].*api-contract-version['"]/.test(content);
    });
    expect(offenders).toEqual([]);
  });
});
