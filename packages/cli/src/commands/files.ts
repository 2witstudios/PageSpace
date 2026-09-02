/**
 * `pagespace files upload` — put a local file into a drive as a FILE page.
 *
 * Thin projection over the SDK's `uploadFile`, which owns the three-leg
 * protocol (presign -> PUT to object storage -> complete) and the slot
 * release on failure. This module's only jobs are argument handling, reading
 * the bytes, and choosing a media type.
 *
 * MEDIA TYPE IS NOT GUESSED BEYOND A KNOWN TABLE. The declared type is signed
 * into the storage PUT and validated server-side, so a wrong guess fails late
 * with an error that names neither the field nor the cause. An unrecognized
 * extension is therefore a usage error asking for `--mime`, not a silent
 * fallback to `application/octet-stream`.
 */
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { uploadFile } from '@pagespace/sdk';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { extractDriveFlag } from './drive-flag.js';
import { callSdk } from './sdk-error.js';

/**
 * Extension -> media type for the formats PageSpace actually processes
 * (the processor's video branch, the image/OCR branch, and the text
 * extractors). Deliberately short: every entry is a type the server accepts,
 * and anything absent is better answered by the caller than by this table.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
};

/** Pure: no I/O. */
export function mimeTypeForPath(path: string): string | undefined {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()];
}

interface UploadFlags {
  readonly parent: string | undefined;
  readonly title: string | undefined;
  readonly mime: string | undefined;
  readonly rest: readonly string[];
}

/** Pure: no I/O. Mirrors `export.ts`'s local flag extraction. */
export function extractUploadFlags(
  args: readonly string[],
): { readonly ok: true; readonly flags: UploadFlags } | { readonly ok: false; readonly message: string } {
  const rest: string[] = [];
  let parent: string | undefined;
  let title: string | undefined;
  let mime: string | undefined;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--parent' || arg === '--title' || arg === '--mime') {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, message: `Flag ${arg} requires a value.` };
      if (arg === '--parent') parent = value;
      else if (arg === '--title') title = value;
      else mime = value;
      i += 2;
      continue;
    }
    rest.push(arg);
    i += 1;
  }
  return { ok: true, flags: { parent, title, mime, rest } };
}

/** Pure: no I/O. Bytes to a short human size, for the pre-upload notice. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export interface FilesUploadDeps {
  readonly readFile: (path: string) => Promise<Uint8Array>;
}

export function createFilesUploadHandler(deps: FilesUploadDeps): CommandHandler {
  return async (ctx, intent) => {
    const driveFlag = extractDriveFlag(intent.args);
    if (!driveFlag.ok) {
      ctx.stderr.write(`${driveFlag.message}\n`);
      return EXIT_USAGE_ERROR;
    }

    const parsed = extractUploadFlags(driveFlag.rest);
    if (!parsed.ok) {
      ctx.stderr.write(`${parsed.message}\n`);
      return EXIT_USAGE_ERROR;
    }

    const [path, ...extra] = parsed.flags.rest;
    if (!path) {
      ctx.stderr.write('Usage: pagespace files upload <path> --drive <driveId> [--parent <pageId>] [--title <title>] [--mime <type>]\n');
      return EXIT_USAGE_ERROR;
    }
    if (extra.length > 0) {
      ctx.stderr.write(`Unknown argument: ${extra[0]}\n`);
      return EXIT_USAGE_ERROR;
    }
    if (!driveFlag.driveId) {
      ctx.stderr.write('Flag --drive is required.\n');
      return EXIT_USAGE_ERROR;
    }

    const filename = basename(path);
    const mimeType = parsed.flags.mime ?? mimeTypeForPath(path);
    if (!mimeType) {
      ctx.stderr.write(`Could not determine a media type for "${filename}". Pass --mime <type>.\n`);
      return EXIT_USAGE_ERROR;
    }

    let bytes: Uint8Array;
    try {
      bytes = await deps.readFile(path);
    } catch (error) {
      ctx.stderr.write(`Failed to read "${path}": ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    // The upload is a single `fetch` PUT, which exposes no byte-level progress,
    // so this is a start notice rather than a progress bar — honest about what
    // is knowable instead of animating a fake one. Suppressed under --json so
    // that mode stays a single parseable line.
    if (!intent.flags.json) {
      ctx.stderr.write(`Uploading ${filename} (${formatBytes(bytes.byteLength)})...\n`);
    }

    const result = await callSdk(ctx.stderr, () =>
      uploadFile(ctx.sdk, {
        driveId: driveFlag.driveId as string,
        bytes,
        filename,
        mimeType,
        title: parsed.flags.title ?? filename,
        parentId: parsed.flags.parent ?? null,
      }),
    );
    if (!result.ok) return EXIT_RUNTIME_ERROR;

    const { page, contentHash, deduplicated } = result.value;

    if (intent.flags.json) {
      ctx.stdout.write(`${JSON.stringify({ pageId: page.id, title: page.title, driveId: page.driveId, contentHash, deduplicated })}\n`);
    } else {
      // Naming the dedup case matters: no bytes were sent, and a caller
      // watching only elapsed time would otherwise think the upload was lost.
      const how = deduplicated ? ' (already stored; no bytes sent)' : '';
      ctx.stdout.write(`Uploaded ${filename} to page ${page.id}${how}\n`);
    }
    return EXIT_SUCCESS;
  };
}

export const filesUploadHandler: CommandHandler = createFilesUploadHandler({
  readFile: (path) => readFile(path),
});
