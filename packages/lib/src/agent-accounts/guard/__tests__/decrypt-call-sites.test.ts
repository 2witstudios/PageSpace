/**
 * L3·G3 exit guard (ADR 0005 §10.14; threat model Λ2): no production file in
 * the monorepo imports a credential decryptor except the plane, the one-way
 * migration, and the ratchet of call sites G3 has not moved yet
 * (`decrypt-guard-policy.ts`). A new direct `decryptCredentials` import — or a
 * raw `decrypt` / `decryptField` in an integration or OAuth path — fails here.
 *
 * The scanner reads source text, not the TypeScript program, so it sees
 * named, namespace, re-export, dynamic and `require` imports alike; a barrel
 * that re-exports a decryptor is itself an importer and is judged like any
 * other file. Test files are excluded: a test calling the codec is not a
 * production read.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideDecryptCallSite, type DecryptImportEdge } from '../decide-decrypt-call-site';
import { ALLOWED_DECRYPT_SITES, DECRYPTORS, LEGACY_PENDING_MIGRATION } from '../decrypt-guard-policy';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const ROOTS = ['apps', 'packages', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'build', 'coverage', 'out', '.turbo', 'ios', 'android', 'drizzle']);
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const TEST_FILE = /(\.test\.|\.spec\.|\/__tests__\/|\/test\/|\/tests\/)/;

const toPosix = (path: string): string => path.split(sep).join('/');

const walk = (dir: string): readonly string[] =>
  readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return SOURCE.test(name) ? [full] : [];
  });

const stripExtension = (path: string): string => path.replace(/\.(d\.ts|ts|tsx|mts|cts|js|mjs|cjs)$/, '');

/** Maps an import specifier to a repo-relative module path, or null for a third-party package. */
const resolveSpecifier = (importer: string, specifier: string): string | null => {
  if (specifier.startsWith('.')) return stripExtension(posix.normalize(posix.join(posix.dirname(importer), specifier)));
  const workspace = /^@pagespace\/(lib|db)(?:\/(.*))?$/.exec(specifier);
  if (workspace !== null) return stripExtension(`packages/${workspace[1]}/src/${workspace[2] ?? 'index'}`);
  const app = /^(apps\/[^/]+)\//.exec(importer);
  if (specifier.startsWith('@/') && app !== null) return stripExtension(`${app[1]}/src/${specifier.slice(2)}`);
  return null;
};

/** `{ a, b as c, type T }` / `* as ns` / `def, { a }` → the value names imported, or `all`. */
const parseClause = (clause: string): readonly string[] | 'all' => {
  if (/\*\s+as\s+\w+/.test(clause) || /^\s*\*\s*$/.test(clause)) return 'all';
  const braces = /\{([\s\S]*)\}/.exec(clause);
  const named = braces === null ? [] : braces[1].split(',').map((part) => part.trim()).filter((part) => part !== '' && !part.startsWith('type '));
  const imported = named.map((part) => part.split(/\s+as\s+/)[0].trim());
  const defaultName = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, '').trim();
  return defaultName === '' ? imported : [...imported, 'default'];
};

const extractEdges = (importer: string, source: string): readonly DecryptImportEdge[] => {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const edges: DecryptImportEdge[] = [];
  const push = (specifier: string, names: readonly string[] | 'all') => {
    const module = resolveSpecifier(importer, specifier);
    if (module !== null) edges.push({ importer, module, names });
  };
  for (const match of text.matchAll(/\bimport\s+(type\s+)?([^'";]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    if (match[1] === undefined) push(match[3], parseClause(match[2]));
  }
  for (const match of text.matchAll(/\bexport\s+(type\s+)?(\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g)) {
    if (match[1] === undefined) push(match[3], parseClause(match[2]));
  }
  for (const match of text.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(match[1], 'all');
  return edges;
};

const productionFiles = (): readonly string[] =>
  ROOTS.flatMap((root) => walk(join(REPO_ROOT, root)))
    .map((file) => toPosix(relative(REPO_ROOT, file)))
    .filter((file) => !TEST_FILE.test(`/${file}`));

describe('decrypt call-site guard (repo scan)', () => {
  const files = productionFiles();
  const verdicts = files.flatMap((importer) =>
    extractEdges(importer, readFileSync(join(REPO_ROOT, importer), 'utf8')).map((edge) => ({ edge, result: decideDecryptCallSite({ edge, decryptors: DECRYPTORS, allowed: ALLOWED_DECRYPT_SITES }) })),
  );

  it('given every production import edge in the monorepo, should find no decryptor imported outside the plane allowlist', () => {
    const actual = verdicts.filter(({ result }) => result.verdict === 'forbidden').map(({ edge }) => `${edge.importer} → ${edge.module}`);
    const expected: readonly string[] = [];
    expect(actual).toEqual(expected);
  });

  it('given the legacy ratchet, should list only files that still import a decryptor — a moved path must leave the list', () => {
    const stillImporting = new Set(verdicts.filter(({ result }) => result.verdict === 'allowed').map(({ edge }) => edge.importer));
    const actual = LEGACY_PENDING_MIGRATION.filter((file) => !stillImporting.has(file));
    const expected: readonly string[] = [];
    expect(actual).toEqual(expected);
  });

  it('given the scanner, should see the repository (a scan of nothing proves nothing)', () => {
    const actual = files.includes('packages/lib/src/integrations/credentials/encrypt-credentials.ts') && files.length > 1000;
    const expected = true;
    expect(actual).toEqual(expected);
  });
});

describe('decrypt call-site guard — scanner', () => {
  const edgesOf = (importer: string, source: string) => extractEdges(importer, source).map(({ module, names }) => ({ module, names }));
  const CREDENTIALS = 'packages/lib/src/integrations/credentials/encrypt-credentials';

  it('given the import spellings a caller could use, should resolve each to the decryptor module', () => {
    const actual = [
      edgesOf('apps/web/src/app/api/x/route.ts', "import { decryptCredentials } from '@pagespace/lib/integrations/credentials/encrypt-credentials';"),
      edgesOf('packages/lib/src/services/x.ts', "import {\n  encryptCredentials,\n  decryptCredentials as d,\n} from '../integrations/credentials/encrypt-credentials.js';"),
      edgesOf('apps/web/src/lib/x.ts', "import * as codec from '@pagespace/lib/integrations/credentials/encrypt-credentials';"),
      edgesOf('packages/lib/src/x.ts', "export { decryptCredentials } from './integrations/credentials/encrypt-credentials';"),
      edgesOf('apps/web/src/lib/x.ts', "const m = await import('@pagespace/lib/integrations/credentials/encrypt-credentials');"),
    ];
    const expected = [
      [{ module: CREDENTIALS, names: ['decryptCredentials'] }],
      [{ module: CREDENTIALS, names: ['encryptCredentials', 'decryptCredentials'] }],
      [{ module: CREDENTIALS, names: 'all' }],
      [{ module: CREDENTIALS, names: ['decryptCredentials'] }],
      [{ module: CREDENTIALS, names: 'all' }],
    ];
    expect(actual).toEqual(expected);
  });

  it('given type-only imports and commented-out imports, should ignore them', () => {
    const actual = edgesOf('apps/web/src/lib/x.ts', "import type { X } from '@pagespace/lib/integrations/credentials/encrypt-credentials';\n// import { decryptCredentials } from '@pagespace/lib/integrations/credentials/encrypt-credentials';");
    const expected: readonly unknown[] = [];
    expect(actual).toEqual(expected);
  });

  it('given a web alias import, should resolve it inside that app', () => {
    const actual = edgesOf('apps/web/src/app/api/x/route.ts', "import { decrypt } from '@/lib/crypto';");
    const expected = [{ module: 'apps/web/src/lib/crypto', names: ['decrypt'] }];
    expect(actual).toEqual(expected);
  });

  it('given a posix dirname of a nested importer, should normalize relative specifiers', () => {
    const actual = resolveSpecifier('packages/lib/src/a/b/c.ts', '../../integrations/credentials/encrypt-credentials');
    const expected = `${dirname('packages/lib/src/x')}/integrations/credentials/encrypt-credentials`;
    expect(actual).toEqual(expected);
  });
});
