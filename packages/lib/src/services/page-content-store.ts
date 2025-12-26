import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { hashWithPrefix } from '../utils/hash-utils';
import type { PageContentFormat } from '../content/page-content-format';

const CONTENT_SUBDIR = 'page-content';
const CONTENT_REF_REGEX = /^[a-f0-9]{64}$/i;

function getContentRoot(): string {
  const base = process.env.PAGE_CONTENT_STORAGE_PATH
    || process.env.FILE_STORAGE_PATH
    || join(process.cwd(), 'storage');
  return join(base, CONTENT_SUBDIR);
}

function assertContentRef(ref: string): void {
  if (!CONTENT_REF_REGEX.test(ref)) {
    throw new Error('Invalid content reference');
  }
}

function getContentPath(ref: string): string {
  assertContentRef(ref);
  const root = getContentRoot();
  const prefix = ref.slice(0, 2);
  return join(root, prefix, ref);
}

export async function writePageContent(
  content: string,
  format: PageContentFormat
): Promise<{ ref: string; size: number }> {
  const ref = hashWithPrefix(format, content);
  const contentPath = getContentPath(ref);
  const dir = dirname(contentPath);

  await fs.mkdir(dir, { recursive: true });

  try {
    await fs.writeFile(contentPath, content, { flag: 'wx' });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || (error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  return { ref, size: Buffer.byteLength(content, 'utf8') };
}

export async function readPageContent(ref: string): Promise<string> {
  const contentPath = getContentPath(ref);
  return fs.readFile(contentPath, 'utf8');
}
