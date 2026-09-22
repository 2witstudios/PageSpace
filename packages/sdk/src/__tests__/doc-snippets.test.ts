/**
 * Every TypeScript sample in the "Sign in with PageSpace" docs compiles
 * against the BUILT SDK (`dist/index.d.ts`, exactly what an npm consumer
 * gets) — the SDK README section, the marketing docs page, and the native
 * guide. A doc sample that drifts from the real API fails here rather than
 * in a reader's editor.
 *
 * Each fenced `ts`/`typescript` block in a doc's sign-in section is type-
 * checked as its own module under `strict`, with the DOM and Node libraries
 * (samples cover browser, server and environment use).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '../..');
const REPO_ROOT = resolve(SDK_ROOT, '../..');
const SDK_DTS = join(SDK_ROOT, 'dist/index.d.ts');

interface Snippet {
  readonly source: string;
  readonly index: number;
  readonly code: string;
}

/** The text from `heading` up to the next heading of the same or higher level (or the end). */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start === -1) throw new Error(`section "${heading}" not found`);
  const level = heading.split(' ')[0];
  const rest = markdown.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n${level} `));
  return next === -1 ? rest : rest.slice(0, next);
}

function fencedTypeScript(markdown: string, source: string): Snippet[] {
  const blocks = [...markdown.matchAll(/```(?:ts|typescript)\n([\s\S]*?)```/g)];
  return blocks.map((match, index) => ({ source, index, code: match[1] }));
}

/** The marketing page keeps its Markdown in a template literal; undo the template escaping. */
function marketingMarkdown(): string {
  const page = readFileSync(join(REPO_ROOT, 'apps/marketing/src/app/docs/features/sdk/page.tsx'), 'utf-8');
  const start = page.indexOf('const content = `');
  const end = page.indexOf('`;\n\nexport default');
  if (start === -1 || end === -1) throw new Error('marketing SDK page content literal not found');
  return page
    .slice(start + 'const content = `'.length, end)
    .replace(/\\`/g, '`')
    .replace(/\\\$/g, '$')
    .replace(/\\\\/g, '\\');
}

function collectSnippets(): Snippet[] {
  const readme = readFileSync(join(SDK_ROOT, 'README.md'), 'utf-8');
  const native = readFileSync(join(REPO_ROOT, 'docs/sdk/native-signin.md'), 'utf-8');
  return [
    ...fencedTypeScript(section(readme, '## Sign in with PageSpace'), 'packages/sdk/README.md'),
    ...fencedTypeScript(section(marketingMarkdown(), '## Sign in with PageSpace'), 'apps/marketing docs/features/sdk'),
    ...fencedTypeScript(native, 'docs/sdk/native-signin.md'),
  ];
}

function typecheck(snippets: readonly Snippet[]): string[] {
  const files = new Map(snippets.map((snippet) => [join(SDK_ROOT, `__doc_snippet_${snippet.source.replace(/\W+/g, '_')}_${snippet.index}.ts`), snippet]));
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: ['node'],
    typeRoots: [join(REPO_ROOT, 'node_modules/@types')],
    skipLibCheck: true,
    baseUrl: SDK_ROOT,
    paths: { '@pagespace/sdk': [SDK_DTS] },
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (fileName) => files.get(fileName)?.code ?? readFile(fileName);
  host.fileExists = (fileName) => files.has(fileName) || fileExists(fileName);
  const program = ts.createProgram([...files.keys()], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file === undefined || files.has(diagnostic.file.fileName))
    .map((diagnostic) => {
      const snippet = diagnostic.file ? files.get(diagnostic.file.fileName) : undefined;
      const where = snippet && diagnostic.file && diagnostic.start !== undefined
        ? `${snippet.source} block ${snippet.index + 1}, line ${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`
        : 'global';
      return `${where}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
    });
}

describe('Sign in with PageSpace — documentation samples', () => {
  it('finds samples in the README, the marketing page and the native guide (guards the test itself)', () => {
    const sources = new Set(collectSnippets().map((snippet) => snippet.source));
    expect(sources).toEqual(new Set(['packages/sdk/README.md', 'apps/marketing docs/features/sdk', 'docs/sdk/native-signin.md']));
  });

  it('compiles every sample against the built SDK', () => {
    expect(existsSync(SDK_DTS)).toBe(true);
    expect(typecheck(collectSnippets())).toEqual([]);
  }, 60_000);
});
