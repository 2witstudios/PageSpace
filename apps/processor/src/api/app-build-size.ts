import { readdir, stat } from 'node:fs/promises';
import { safeBuildPath } from './app-build-paths';

/**
 * Total on-disk size of `boundary`, recursively. Used as a post-extraction
 * ceiling — a crafted archive can compress small and expand huge, so the
 * pre-upload byte cap on the COMPRESSED tarball (`MAX_UPLOAD_BYTES` in
 * `app-build.ts`) is not by itself a bound on what lands on disk.
 *
 * Every join is re-derived through `safeBuildPath` bounded to `boundary` —
 * the directory this function was originally called with, carried through
 * every recursive call rather than re-resolved — so an entry name (read
 * straight off the filesystem `tar` just extracted, invoked with
 * `--no-same-owner --no-same-permissions` precisely because that archive is
 * untrusted) can never walk the recursion outside the tree being measured.
 */
export async function getDirectorySize(boundary: string, relPath: string[] = []): Promise<number> {
  let total = 0;
  const dir = safeBuildPath(boundary, ...relPath);
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const childRelPath = [...relPath, entry.name];
    const entryPath = safeBuildPath(boundary, ...childRelPath);
    if (entry.isDirectory()) {
      total += await getDirectorySize(boundary, childRelPath);
    } else if (entry.isFile()) {
      total += (await stat(entryPath)).size;
    }
  }
  return total;
}
