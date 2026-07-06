/**
 * Structural enforcement (Phase 4 task 7): command modules must obtain
 * authentication ONLY through `ctx.sdk` (built once, by the resolver, in
 * `run.ts`). No command file may read `PAGESPACE_TOKEN` itself or construct
 * its own `PageSpaceClient`/`StaticTokenProvider`/`OAuthTokenProvider` — that
 * would create a second, un-audited auth path alongside the resolver.
 *
 * `login.ts` is not exempted by name: it simply never touches any of these
 * patterns (it authenticates via raw discovery/token-exchange fetches, not
 * a PageSpaceClient), so it passes the same check as every other command.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = join(__dirname, '..');

const FORBIDDEN_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: 'reads PAGESPACE_TOKEN directly', pattern: /PAGESPACE_TOKEN/ },
  { name: 'reads process.env directly (must go through ctx.env)', pattern: /process\.env/ },
  { name: 'constructs its own PageSpaceClient', pattern: /new PageSpaceClient\(/ },
  { name: 'constructs its own StaticTokenProvider', pattern: /new StaticTokenProvider\(/ },
  { name: 'constructs its own OAuthTokenProvider', pattern: /new OAuthTokenProvider\(/ },
];

function commandSourceFiles(): string[] {
  // Recurse into subdirectories (e.g. commands/tokens/) — a non-recursive
  // readdir would silently skip every command module nested one level
  // deeper, letting a forbidden pattern hide there unchecked.
  return readdirSync(COMMANDS_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('single auth path — command modules', () => {
  const files = commandSourceFiles();

  it('finds at least one command module to check (the check is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('recurses into subdirectories (e.g. commands/tokens/) rather than skipping nested command modules', () => {
    expect(files.some((file) => file.includes(`${join('tokens', 'revoke.ts')}`))).toBe(true);
  });

  for (const file of files) {
    for (const { name, pattern } of FORBIDDEN_PATTERNS) {
      it(`${file.split('/').pop()} never ${name}`, () => {
        const source = readFileSync(file, 'utf-8');
        expect(source).not.toMatch(pattern);
      });
    }
  }
});
