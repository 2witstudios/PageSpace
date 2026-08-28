import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Total on-disk size of `dir`, recursively. Used as a post-extraction
 * ceiling — a crafted archive can compress small and expand huge, so the
 * pre-upload byte cap on the COMPRESSED tarball (`MAX_UPLOAD_BYTES` in
 * `app-build.ts`) is not by itself a bound on what lands on disk.
 */
export async function getDirectorySize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await getDirectorySize(entryPath);
    } else if (entry.isFile()) {
      total += (await stat(entryPath)).size;
    }
  }
  return total;
}
