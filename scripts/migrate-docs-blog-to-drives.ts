#!/usr/bin/env bun
/**
 * One-off migration: move the docs and blog out of `apps/marketing` and into
 * two PageSpace drives, published through PageSpace's own Canvas-publishing
 * pipeline.
 *
 * The content ends up served from object storage at `docs.pagespace.ai` /
 * `blog.pagespace.ai` (canonical) with the drives' `*.pagespace.site`
 * subdomains as mirrors, which lets the edge stop path-mounting marketing onto
 * `pagespace.ai` — see `.pu/…/plans` and the Caddyfile change in
 * PageSpace-Deploy.
 *
 * Usage:
 *   # See exactly what would be created, writing the rendered tree to disk.
 *   bun scripts/migrate-docs-blog-to-drives.ts --dry-run --out /tmp/migration
 *
 *   # For real (creates pages and PUBLISHES THEM PUBLICLY):
 *   PAGESPACE_API_KEY=… bun scripts/migrate-docs-blog-to-drives.ts \
 *     --docs-drive <driveId> --blog-drive <driveId>
 *
 * Flags:
 *   --dry-run            Render everything locally; make no API calls.
 *   --out <dir>          Dry-run output directory (default: ./.migration-preview).
 *   --docs-drive <id>    Target drive for the docs. Omit to skip docs.
 *   --blog-drive <id>    Target drive for the blog. Omit to skip the blog.
 *   --api-url <url>      API base (default: $PAGESPACE_API_URL or https://pagespace.ai).
 *   --docs-host <host>   Canonical docs host (default: docs.pagespace.ai).
 *   --blog-host <host>   Canonical blog host (default: blog.pagespace.ai).
 *
 * Environment:
 *   PAGESPACE_API_KEY    Required unless --dry-run. A drive-scoped key with
 *                        write access to both target drives (`pagespace keys
 *                        create --drive <id> --role member`).
 *
 * Re-running is safe-ish but NOT idempotent: it creates new pages every time.
 * Trash the drive's contents before a second live run.
 */

import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import {
  extractDocs,
  extractPosts,
  findBrokenNavLinks,
  rewriteLinks,
  imageMimeType,
  REPO_ROOT,
  type ExtractedDoc,
  type ExtractedPost,
  type RewriteHosts,
} from './lib/extract-marketing-content';

// ── args ─────────────────────────────────────────────────────────────────────

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

const DRY_RUN = has('dry-run');
const OUT_DIR = flag('out') ?? join(REPO_ROOT, '.migration-preview');
const DOCS_DRIVE = flag('docs-drive');
const BLOG_DRIVE = flag('blog-drive');
const API_URL = (flag('api-url') ?? process.env.PAGESPACE_API_URL ?? 'https://pagespace.ai').replace(/\/$/, '');
const API_KEY = process.env.PAGESPACE_API_KEY;

const HOSTS: RewriteHosts = {
  docs: `https://${flag('docs-host') ?? 'docs.pagespace.ai'}`,
  blog: `https://${flag('blog-host') ?? 'blog.pagespace.ai'}`,
  marketing: 'https://pagespace.ai',
};

// ── api ──────────────────────────────────────────────────────────────────────

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${res.statusText}\n${(await res.text()).slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

interface PageRef {
  id: string;
}

const createPage = (input: {
  driveId: string;
  title: string;
  type: 'DOCUMENT' | 'FOLDER';
  parentId: string | null;
  content?: string;
}) => api<PageRef>('POST', '/api/pages', { ...input, contentMode: 'markdown' });

/**
 * Publish a page at `path` on its drive's site. `path` is the URL the old
 * marketing route mapped to, so the edge 301s land on a real page.
 */
const publishPage = (
  pageId: string,
  body: { path: string; title: string; description?: string; ogImageFileId?: string },
) => api<unknown>('POST', `/api/pages/${pageId}/publish`, body);

// ── shared helpers ───────────────────────────────────────────────────────────

/** Ensure a folder chain exists under a drive, memoized by path. */
function folderFactory(driveId: string, cache: Map<string, string>) {
  return async function ensureFolder(segments: string[]): Promise<string | null> {
    let parentId: string | null = null;
    let soFar = '';
    for (const segment of segments) {
      soFar += `/${segment}`;
      const cached = cache.get(soFar);
      if (cached) {
        parentId = cached;
        continue;
      }
      const title = titleCase(segment);
      const created: PageRef = DRY_RUN
        ? { id: `dry:${soFar}` }
        : await createPage({ driveId, title, type: 'FOLDER', parentId });
      cache.set(soFar, created.id);
      parentId = created.id;
    }
    return parentId;
  };
}

function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

async function writePreview(relPath: string, contents: string): Promise<void> {
  const full = join(OUT_DIR, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, contents, 'utf8');
}

// ── docs ─────────────────────────────────────────────────────────────────────

async function migrateDocs(driveId: string | undefined, docs: ExtractedDoc[]): Promise<void> {
  console.log(`\n=== docs (${docs.length} pages) ===`);
  const folders = folderFactory(driveId ?? 'dry', new Map());

  // Deepest last, so a parent folder always exists before its children.
  const ordered = [...docs].sort((a, b) => a.newPath.split('/').length - b.newPath.split('/').length);

  for (const doc of ordered) {
    const markdown = rewriteLinks(doc.markdown, 'docs', HOSTS);
    const segments = doc.newPath.split('/').filter(Boolean);
    const parentSegments = segments.slice(0, -1);

    if (DRY_RUN) {
      await writePreview(`docs${doc.newPath === '/' ? '/index' : doc.newPath}.md`, markdown);
      console.log(`  ${doc.oldPath.padEnd(42)} → ${doc.newPath.padEnd(34)} ${doc.title}`);
      continue;
    }

    const parentId = parentSegments.length ? await folders(parentSegments) : null;
    const page = await createPage({
      driveId: driveId!,
      title: doc.title,
      type: 'DOCUMENT',
      parentId,
      content: markdown,
    });
    await publishPage(page.id, {
      path: doc.newPath,
      title: doc.title,
      ...(doc.description ? { description: doc.description } : {}),
    });
    console.log(`  published ${doc.newPath}`);
  }
}

// ── blog ─────────────────────────────────────────────────────────────────────

/**
 * Blog images are referenced from post bodies as `/blog/<file>` paths served
 * out of `apps/marketing/public`. They have to become real uploaded assets on
 * the new host, so every referenced file is uploaded first and the body
 * rewritten against the resulting URL map BEFORE `rewriteLinks` runs — a
 * leftover `/blog/x.png` would otherwise be rewritten into a page path that
 * serves no image.
 */
function collectImageRefs(posts: ExtractedPost[]): string[] {
  const refs = new Set<string>();
  for (const post of posts) {
    for (const m of post.markdown.matchAll(/!\[[^\]]*\]\((\/blog\/[^)\s]+)\)/g)) refs.add(m[1]);
    if (post.imageFile) refs.add(`/${post.imageFile.split('apps/marketing/public/')[1]}`);
  }
  return [...refs].sort();
}

/**
 * Upload one image as a FILE page and return its page id.
 *
 * Uses the same presign → PUT → complete flow the web client uses
 * (`/api/upload/presign`, `/api/upload/complete`); `contentHash` is the sha256
 * the presign step reserves the slot against (the route validates it against
 * `/^[0-9a-fA-F]{64}$/`).
 */
async function uploadImage(driveId: string, absPath: string, parentId: string | null): Promise<string> {
  const bytes = new Uint8Array(await readFile(absPath));
  const contentHash = Bun.SHA256.hash(bytes, 'hex');
  const filename = basename(absPath);
  const mimeType = imageMimeType(filename);

  const presign = await api<{ url?: string; jobId: string; alreadyExists?: boolean }>(
    'POST',
    '/api/upload/presign',
    { contentHash, driveId, filename, mimeType, fileSize: bytes.byteLength },
  );

  // `alreadyExists` means the object is already in storage (content-addressed
  // dedup) and there is nothing to PUT — go straight to complete.
  if (!presign.alreadyExists) {
    if (!presign.url) throw new Error(`presign returned no URL for ${filename}`);
    const put = await fetch(presign.url, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: bytes,
    });
    if (!put.ok) throw new Error(`PUT ${filename} → ${put.status} ${put.statusText}`);
  }

  // Note the envelope: /api/upload/complete answers `{ success, page }`,
  // unlike /api/pages which returns the page object bare.
  const done = await api<{ success: boolean; page: PageRef }>('POST', '/api/upload/complete', {
    jobId: presign.jobId,
    title: filename,
    parentId,
  });
  if (!done.page?.id) throw new Error(`upload/complete returned no page id for ${filename}`);
  return done.page.id;
}

async function migrateBlog(driveId: string | undefined, posts: ExtractedPost[]): Promise<void> {
  console.log(`\n=== blog (${posts.length} posts) ===`);

  const imageRefs = collectImageRefs(posts);
  console.log(`  ${imageRefs.length} referenced images:`);
  for (const ref of imageRefs) {
    const abs = join(REPO_ROOT, 'apps/marketing/public', ref);
    const bytes = await stat(abs).then((s) => s.size).catch(() => -1);
    const flagBig = bytes > 1_000_000 ? '  ⚠️  oversized — compress before a live run' : '';
    console.log(`    ${ref.padEnd(48)} ${bytes < 0 ? 'MISSING' : `${(bytes / 1024 / 1024).toFixed(1)} MB`}${flagBig}`);
  }

  // Upload every referenced image first and build `/blog/x.png` → file id.
  // Bodies are rewritten against this map BEFORE rewriteLinks, so the publish
  // pipeline sees `/api/files/<id>/view` and resolves it to a public CDN URL.
  const assetIds = new Map<string, string>();
  if (!DRY_RUN) {
    const assetFolder = await createPage({
      driveId: driveId!,
      title: 'Post Images',
      type: 'FOLDER',
      parentId: null,
    });
    for (const ref of imageRefs) {
      const id = await uploadImage(driveId!, join(REPO_ROOT, 'apps/marketing/public', ref), assetFolder.id);
      assetIds.set(ref, id);
      console.log(`  uploaded ${ref} → ${id}`);
    }
  }

  for (const post of posts) {
    const withAssets = post.markdown.replace(
      /(!\[[^\]]*\]\()(\/blog\/[^)\s]+)(\))/g,
      (whole, open: string, ref: string, close: string) => {
        const id = assetIds.get(ref);
        if (id) return `${open}/api/files/${id}/view${close}`;
        if (!DRY_RUN) throw new Error(`No uploaded asset for ${ref} (referenced by ${post.oldPath})`);
        return whole;
      },
    );
    const markdown = rewriteLinks(withAssets, 'blog', HOSTS);

    if (DRY_RUN) {
      await writePreview(`blog${post.newPath}.md`, markdown);
      console.log(`  ${post.oldPath.padEnd(46)} → ${post.newPath.padEnd(40)} ${post.date}`);
      continue;
    }

    const page = await createPage({
      driveId: driveId!,
      title: post.title,
      type: 'DOCUMENT',
      parentId: null,
      content: markdown,
    });

    const heroRef = post.imageFile ? `/${post.imageFile.split('apps/marketing/public/')[1]}` : null;
    const heroId = heroRef ? assetIds.get(heroRef) : undefined;
    await publishPage(page.id, {
      path: post.newPath,
      title: post.title,
      description: post.description,
      ...(heroId ? { ogImageFileId: heroId } : {}),
    });
    console.log(`  published ${post.newPath}`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!DRY_RUN && !API_KEY) {
    throw new Error('PAGESPACE_API_KEY is required for a live run (or pass --dry-run)');
  }
  if (!DRY_RUN && !DOCS_DRIVE && !BLOG_DRIVE) {
    throw new Error('Pass --docs-drive and/or --blog-drive for a live run');
  }

  const broken = await findBrokenNavLinks();
  if (broken.length) {
    console.log('Dead nav links found in docs-nav.ts (repaired during rewrite where a mapping exists):');
    for (const b of broken) console.log(`  ${b.href}  ("${b.title}")`);
  }

  const [docs, posts] = await Promise.all([extractDocs(), extractPosts()]);

  if (DOCS_DRIVE || DRY_RUN) await migrateDocs(DOCS_DRIVE, docs);
  if (BLOG_DRIVE || DRY_RUN) await migrateBlog(BLOG_DRIVE, posts);

  if (DRY_RUN) {
    console.log(`\nDry run complete. Rendered markdown written to ${OUT_DIR}`);
    console.log('Nothing was created and nothing was published.');
  } else {
    console.log('\nDone. Verify the objects landed in the bucket before touching the Caddyfile:');
    console.log(`  curl -sI ${HOSTS.docs}/features/cli`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
