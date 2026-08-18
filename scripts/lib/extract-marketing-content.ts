/**
 * Extracts the docs and blog content currently embedded in `apps/marketing` so
 * it can be migrated into PageSpace drives (see
 * `scripts/migrate-docs-blog-to-drives.ts`).
 *
 * Both sources hold real markdown, just wrapped in TypeScript:
 *
 * - Docs: 34 `apps/marketing/src/app/docs/**\/page.tsx` files, each with a
 *   module-scope `const content = \`...\`` template literal rendered through
 *   `<DocsMarkdown>`.
 * - Blog: one `apps/marketing/src/app/blog/[slug]/data.ts` exporting
 *   `blogPosts`, whose `content` fields are the same kind of literal.
 *
 * The docs literals are EVALUATED as real template literals rather than
 * string-scraped. That is not fussiness — it is the only way to get both of
 * these right at once:
 *
 *   `${MONTHLY_CREDITS.free}`  → must interpolate (a live value from
 *                                `apps/marketing/src/lib/credits.ts`)
 *   `\${TIMESTAMP}`            → must stay literal (it is shell/JS sample code
 *                                inside the incoming-webhooks docs)
 *
 * A regex substitution pass gets the second case wrong every time; JS template
 * semantics get both right for free.
 */

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repo root, derived from this file's location (scripts/lib/…).
 *
 * Uses `import.meta.url` rather than bun's `import.meta.dir` so the module also
 * loads under vitest/node, where `dir` is undefined.
 */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MARKETING_SRC = join(REPO_ROOT, 'apps/marketing/src');
const DOCS_ROOT = join(MARKETING_SRC, 'app/docs');

export interface ExtractedDoc {
  /** Source file, repo-relative — used in error messages and the dry-run report. */
  sourceFile: string;
  /** Public path today, e.g. `/docs/features/cli`. `/docs` for the index. */
  oldPath: string;
  /** Path on the new host, e.g. `/features/cli`. `/` for the index. */
  newPath: string;
  /** Title from `createMetadata({ title })`. */
  title: string;
  /** Description from `createMetadata({ description })`, if present. */
  description: string | null;
  /** The fully-evaluated markdown body. */
  markdown: string;
}

export interface ExtractedPost {
  slug: string;
  title: string;
  description: string;
  markdown: string;
  author: string;
  /** `YYYY-MM-DD`. */
  date: string;
  readTime: string;
  category: string;
  featured: boolean;
  /** Repo-relative path to the hero image, or null when the post has none. */
  imageFile: string | null;
  oldPath: string;
  newPath: string;
}

/** Recursively collect every `page.tsx` beneath `dir`. */
async function findPageFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findPageFiles(full)));
    else if (entry.name === 'page.tsx') found.push(full);
  }
  return found.sort();
}

/**
 * Find the `const content = \`...\`;` literal in a source file and return its
 * span, backticks included.
 *
 * Walks the string rather than using a regex because the literal contains
 * escaped backticks (\\\`) around every inline code span and fenced block, and
 * a non-greedy regex stops at the first of those.
 */
function findContentLiteral(source: string, sourceFile: string): { start: number; end: number } | null {
  const marker = /(?:^|\n)\s*const content\s*=\s*`/.exec(source);
  // Three pages (`/docs`, `/docs/features`, `/docs/integrations`) are JSX card
  // grids rather than prose, so they legitimately have no literal. The caller
  // synthesizes those from `docsNav` instead — see `buildHubMarkdown`.
  if (!marker) return null;
  const start = marker.index + marker[0].length - 1; // index of the opening backtick

  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') {
      i++; // skip the escaped character
      continue;
    }
    if (source[i] === '`') return { start, end: i + 1 };
  }
  throw new Error(`Unterminated \`content\` template literal in ${sourceFile}`);
}

/**
 * Pull a single string field out of the `createMetadata({ ... })` call.
 *
 * Scoped to that call rather than the whole file: the three hub pages declare
 * a card array (`const referenceSections = [{ title: … }]`) ABOVE their
 * metadata, so a file-wide search returns the first card's title instead of
 * the page's own — which is how `/docs` came out titled "Page Types".
 */
function readMetadataField(
  source: string,
  field: 'title' | 'description',
  sharedMetadata?: string,
): string | null {
  // `/docs/page.tsx` does not call createMetadata itself — it re-exports a
  // shared entry (`export const metadata = pageMetadata.docs`). Resolve that
  // indirection against `lib/metadata.ts`, or the page reads as "Untitled".
  const shared = /export const metadata\s*=\s*pageMetadata\.(\w+)/.exec(source);
  if (shared && sharedMetadata) {
    const key = shared[1];
    const entryStart = new RegExp(`^\\s{2}${key}:\\s*createMetadata\\(\\{`, 'm').exec(sharedMetadata);
    if (entryStart) {
      return readMetadataField(sharedMetadata.slice(entryStart.index), field);
    }
  }

  const callStart = source.indexOf('createMetadata({');
  if (callStart === -1) return null;
  // The call is the last statement of interest; bounding at the closing `});`
  // keeps a later object literal from leaking in.
  const callEnd = source.indexOf('});', callStart);
  const scope = source.slice(callStart, callEnd === -1 ? undefined : callEnd);

  const re = new RegExp(`(?:^|[{,]\\s*)${field}:\\s*(["'])((?:\\\\.|(?!\\1).)*)\\1`, 's');
  const m = re.exec(scope);
  if (!m) return null;
  // Undo the escaping of the quote style actually used.
  return m[2].replace(new RegExp(`\\\\${m[1]}`, 'g'), m[1]).replace(/\\\\/g, '\\');
}

/**
 * Evaluate the extracted literals for real.
 *
 * Every literal is compiled into ONE temporary module written inside
 * `apps/marketing/src` so the `@/lib/credits` style path aliases in scope
 * resolve exactly as they do in the app. The module is imported once, then
 * deleted. Doing all files in a single module keeps this to one import.
 */
async function evaluateLiterals(
  literals: { key: string; imports: string[]; literal: string }[],
): Promise<Map<string, string>> {
  const importLines = [...new Set(literals.flatMap((l) => l.imports))];
  const body = literals
    .map(({ key, literal }) => `  ${JSON.stringify(key)}: ${literal},`)
    .join('\n');

  const moduleSource = `${importLines.join('\n')}\nexport const extracted: Record<string, string> = {\n${body}\n};\n`;

  const tmpDir = join(MARKETING_SRC, '__migration_tmp__');
  const tmpFile = join(tmpDir, `extract-${process.pid}.ts`);
  await mkdir(tmpDir, { recursive: true });
  await writeFile(tmpFile, moduleSource, 'utf8');

  try {
    // Cache-bust so repeated runs in one process re-read the file.
    const mod = (await import(`${tmpFile}?t=${process.pid}`)) as { extracted: Record<string, string> };
    return new Map(Object.entries(mod.extracted));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Import lines a docs page needs for its literal to evaluate. Only value
 * imports matter — the React/lucide/metadata imports are dropped, since the
 * literal never references them.
 */
function collectValueImports(source: string): string[] {
  const lines: string[] = [];
  const importRe = /^import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'];?$/gm;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) {
    const from = m[2];
    // Skip the render/metadata plumbing; keep genuine constant modules.
    if (from.includes('/components/') || from.endsWith('/metadata') || from === 'react') continue;
    if (from.startsWith('lucide-react') || from.startsWith('next')) continue;
    // Rewrite the `@/` alias by hand. The temp module lives one level below
    // `apps/marketing/src`, but bun resolves tsconfig `paths` against the
    // ROOT tsconfig when invoked from the repo root, so the alias would not
    // resolve there.
    const specifier = from.startsWith('@/') ? `../${from.slice(2)}` : from;
    lines.push(`import {${m[1]}} from ${JSON.stringify(specifier)};`);
  }
  return lines;
}

/** Map a docs `page.tsx` path to its public route. */
function docRouteFor(file: string): string {
  const rel = relative(DOCS_ROOT, dirname(file));
  return rel === '' ? '/docs' : `/docs/${rel}`;
}

/**
 * Read the `{ title, href }` pairs out of `docs-nav.ts`, grouped by section.
 *
 * Parsed rather than imported: `docs-nav.ts` pulls ~30 icon components from
 * `lucide-react` that this script has no use for, and the file's shape is
 * uniform enough that parsing is the cheaper, dependency-free read.
 */
async function readDocsNav(): Promise<{ title: string; items: { title: string; href: string }[] }[]> {
  const source = await readFile(join(DOCS_ROOT, 'docs-nav.ts'), 'utf8');
  const navStart = source.indexOf('export const docsNav');
  if (navStart === -1) throw new Error('docs-nav.ts: no `export const docsNav` found');

  const sections: { title: string; items: { title: string; href: string }[] }[] = [];
  const sectionRe = /\{\s*\n\s*title:\s*"((?:\\.|[^"\\])*)",\s*\n\s*icon:\s*\w+,\s*\n\s*items:\s*\[([\s\S]*?)\n\s*\],\s*\n\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(source.slice(navStart))) !== null) {
    const items: { title: string; href: string }[] = [];
    const itemRe = /\{\s*title:\s*"((?:\\.|[^"\\])*)",\s*href:\s*"([^"]+)"/g;
    let im: RegExpExecArray | null;
    while ((im = itemRe.exec(m[2])) !== null) items.push({ title: im[1], href: im[2] });
    sections.push({ title: m[1], items });
  }
  if (sections.length === 0) throw new Error('docs-nav.ts: parsed zero sections — the file shape changed');
  return sections;
}

/**
 * Build markdown for one of the three JSX hub pages. `/docs` lists every
 * section; a section hub (`/docs/features`) lists just its own children.
 *
 * Emits the ORIGINAL `/docs/x` hrefs. `rewriteLinks` shortens them afterwards,
 * exactly as it does for links inside hand-written prose — pre-shortening here
 * would leave `/x` looking like a marketing path to that pass, which then
 * absolutized it to `https://pagespace.ai/x`.
 */
function buildHubMarkdown(
  oldPath: string,
  sections: { title: string; items: { title: string; href: string }[] }[],
  describe: (href: string) => string | null,
): string {
  const line = (item: { title: string; href: string }) => {
    const desc = describe(item.href);
    return `- [${item.title}](${item.href})${desc ? ` — ${desc}` : ''}`;
  };

  if (oldPath === '/docs') {
    const body = sections
      .map((s) => `## ${s.title}\n\n${s.items.filter((i) => i.href !== '/docs').map(line).join('\n')}`)
      .join('\n\n');
    return `# PageSpace Documentation\n\n${body}`;
  }

  const section = sections.find((s) => s.items.some((i) => i.href === oldPath));
  if (!section) throw new Error(`No docsNav section owns the hub page ${oldPath}`);
  const children = section.items.filter((i) => i.href !== oldPath);
  return `# ${section.title}\n\n${children.map(line).join('\n')}`;
}

/** Extract every docs page, with interpolations resolved. */
export async function extractDocs(): Promise<ExtractedDoc[]> {
  const files = await findPageFiles(DOCS_ROOT);

  const sources = await Promise.all(
    files.map(async (file) => ({ file, source: await readFile(file, 'utf8') })),
  );

  const literals = sources.flatMap(({ file, source }) => {
    const span = findContentLiteral(source, relative(REPO_ROOT, file));
    if (!span) return [];
    return [{ key: file, imports: collectValueImports(source), literal: source.slice(span.start, span.end) }];
  });

  const evaluated = await evaluateLiterals(literals);
  const nav = await readDocsNav();
  const sharedMetadata = await readFile(join(MARKETING_SRC, 'lib/metadata.ts'), 'utf8');

  const meta = new Map(
    sources.map(({ file, source }) => [
      docRouteFor(file),
      {
        title: readMetadataField(source, 'title', sharedMetadata),
        description: readMetadataField(source, 'description', sharedMetadata),
      },
    ]),
  );
  const describe = (href: string) => meta.get(href)?.description ?? null;

  return sources.map(({ file, source }) => {
    const oldPath = docRouteFor(file);
    const markdown = evaluated.get(file) ?? buildHubMarkdown(oldPath, nav, describe);
    return {
      sourceFile: relative(REPO_ROOT, file),
      oldPath,
      newPath: oldPath === '/docs' ? '/' : oldPath.slice('/docs'.length),
      title: readMetadataField(source, 'title', sharedMetadata) ?? 'Untitled',
      description: readMetadataField(source, 'description', sharedMetadata),
      markdown: markdown.trim(),
    };
  });
}

/** Hosts the rewritten content points at. */
export interface RewriteHosts {
  /** e.g. `https://docs.pagespace.ai` */
  docs: string;
  /** e.g. `https://blog.pagespace.ai` */
  blog: string;
  /** e.g. `https://pagespace.ai` — everything the marketing site still owns. */
  marketing: string;
}

/**
 * Nav/body links that pointed at a page which does not exist. `docs-nav.ts`
 * currently links `/docs/features/agent-workspaces` while the page actually
 * lives at `/docs/features/agent-sessions`, so that entry 404s on the live
 * site today. Repaired here rather than faithfully carried across.
 */
const LINK_REPAIRS: Record<string, string> = {
  '/docs/features/agent-workspaces': '/docs/features/agent-sessions',
};

/**
 * Rewrite root-relative links in a markdown body for its new origin.
 *
 * Docs and blog stop sharing an origin with each other and with marketing, so
 * a link that used to be a same-site path has to become either a shorter path
 * (same site, new root) or an absolute URL (now a different host). Anything
 * left as a bare `/pricing` would resolve against the WRONG host after the
 * move and 404.
 *
 * `site` says which of the two new hosts owns this body.
 */
export function rewriteLinks(markdown: string, site: 'docs' | 'blog', hosts: RewriteHosts): string {
  return markdown.replace(/\]\((\/[^)\s]*)\)/g, (whole, target: string) => {
    // Split at the FIRST '#' by index. `split(/(?=#)/, 2)` looks equivalent but
    // the limit truncates rather than rejoins, so `/docs/a#b#c` silently loses
    // `#c` and the link lands on a different fragment.
    const hashIndex = target.indexOf('#');
    const rawPath = hashIndex === -1 ? target : target.slice(0, hashIndex);
    const suffix = hashIndex === -1 ? '' : target.slice(hashIndex);
    const path = LINK_REPAIRS[rawPath] ?? rawPath;

    const strip = (prefix: string) => (path === prefix ? '/' : path.slice(prefix.length));

    // `/api/files/<id>/view` references are placeholders the PUBLISH pipeline
    // resolves — `rewriteCanvasAssets` swaps them for public CDN URLs and
    // copies the object into the publish bucket. Absolutizing them here would
    // hide them from that pass and leave every blog image behind an
    // authenticated app route.
    if (path.startsWith('/api/')) return whole;

    if (path === '/docs' || path.startsWith('/docs/')) {
      return site === 'docs' ? `](${strip('/docs')}${suffix})` : `](${hosts.docs}${strip('/docs')}${suffix})`;
    }
    if (path === '/blog' || path.startsWith('/blog/')) {
      return site === 'blog' ? `](${strip('/blog')}${suffix})` : `](${hosts.blog}${strip('/blog')}${suffix})`;
    }
    // Everything else still belongs to the marketing site.
    return `](${hosts.marketing}${path}${suffix})`;
  });
}

/**
 * Nav links whose target page does not exist. Surfaced so the migration does
 * not silently carry a dead link into the new site.
 */
export async function findBrokenNavLinks(): Promise<{ title: string; href: string }[]> {
  const [nav, files] = await Promise.all([readDocsNav(), findPageFiles(DOCS_ROOT)]);
  const real = new Set(files.map(docRouteFor));
  return nav.flatMap((s) => s.items.filter((i) => !real.has(i.href)));
}

/**
 * Extract the blog posts. `data.ts` is plain TypeScript with no imports, so it
 * is imported directly — no temp-module dance needed.
 */
export async function extractPosts(): Promise<ExtractedPost[]> {
  const dataFile = join(MARKETING_SRC, 'app/blog/[slug]/data.ts');
  const mod = (await import(dataFile)) as {
    blogPosts: Record<
      string,
      {
        slug: string;
        title: string;
        description: string;
        content: string;
        author: string;
        date: string;
        readTime: string;
        category: string;
        featured?: boolean;
        image?: string;
      }
    >;
  };

  return Object.values(mod.blogPosts).map((post) => ({
    slug: post.slug,
    title: post.title,
    description: post.description,
    markdown: post.content.trim(),
    author: post.author,
    date: post.date,
    readTime: post.readTime,
    category: post.category,
    featured: post.featured ?? false,
    // `image` is a public-dir URL like `/blog/foo.png`.
    imageFile: post.image ? join('apps/marketing/public', post.image) : null,
    oldPath: `/blog/${post.slug}`,
    newPath: `/${post.slug}`,
  }));
}

/**
 * Image MIME types by file extension.
 *
 * `collectImageRefs` takes whatever `/blog/<file>` paths the posts reference,
 * so the type has to come from the asset rather than being assumed. Everything
 * is `.png` today, but declaring `image/png` for a future `.jpg` hero would
 * store a file whose declared type contradicts its bytes.
 *
 * SVG is deliberately absent: `/api/upload/presign` rejects `image/svg+xml`
 * outright (it is in `BLOCKED_MIME_TYPES`, `packages/lib/src/services/
 * upload-validation.ts`, because SVG is a script-execution vector), so an
 * entry here would only turn a clear local error into a confusing 400.
 */
export const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

/** Resolve an asset's MIME type, or fail loudly rather than guess. */
export function imageMimeType(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const ext = dot === -1 ? '' : filename.slice(dot).toLowerCase();
  const mime = IMAGE_MIME_TYPES[ext];
  if (!mime) {
    throw new Error(
      `Unsupported image type "${ext || '(none)'}" for ${filename}. ` +
        `Supported: ${Object.keys(IMAGE_MIME_TYPES).join(', ')}.`,
    );
  }
  return mime;
}
