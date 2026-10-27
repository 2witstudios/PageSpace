import { describe, expect, it, vi } from 'vitest';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, parseArgv } from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';
import { createFilesUploadHandler, extractUploadFlags, formatBytes, mimeTypeForPath } from '../files.js';

function commandIntent(argv: string[]): CommandIntent {
  const intent = parseArgv(['__cmd__', ...argv]);
  if (intent.kind !== 'command') throw new Error('expected command');
  return { ...intent, args: intent.args.slice(1) };
}

const PAGE = { id: 'pg_1', title: 'clip.mp4', driveId: 'drv_1' };

/**
 * `uploadFile` drives the client through `invoke`, so the fake sdk is an
 * invoke stub keyed by operation name — the same seam the SDK's own tests use.
 */
function fakeUploadSdk(options: { alreadyExists?: boolean; failComplete?: boolean } = {}) {
  const calls: string[] = [];
  const invoke = vi.fn(async (op: { name: string }) => {
    calls.push(op.name);
    if (op.name === 'uploads.presign') {
      return options.alreadyExists
        ? { alreadyExists: true, jobId: 'job_1', key: 'k' }
        : { url: 'https://storage.example/put', jobId: 'job_1', key: 'k', expiresAt: 'later' };
    }
    if (op.name === 'uploads.complete') {
      if (options.failComplete) throw new Error('complete failed');
      return { success: true, page: PAGE };
    }
    if (op.name === 'uploads.cancel') return { success: true };
    throw new Error(`unexpected ${op.name}`);
  });
  return { sdk: fakeSdk({ invoke }), calls, invoke };
}


/** A context plus readable sinks — `createRecordingSink` collects into `lines`. */
function makeCtx(sdk: ReturnType<typeof fakeSdk>) {
  const stdout = createRecordingSink();
  const stderr = createRecordingSink();
  return { ctx: createFakeContext({ sdk, stdout, stderr }), out: () => stdout.lines.join(''), err: () => stderr.lines.join('') };
}

const BYTES = new TextEncoder().encode('hello');
const okFetch = () => vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

function deps(read: () => Promise<Uint8Array> = async () => BYTES) {
  return { readFile: vi.fn(read) };
}

describe('pure helpers', () => {
  it('maps known media extensions and refuses to guess unknown ones', () => {
    expect(mimeTypeForPath('/x/clip.MP4')).toBe('video/mp4');
    expect(mimeTypeForPath('/x/notes.md')).toBe('text/markdown');
    expect(mimeTypeForPath('/x/archive.xyz')).toBeUndefined();
  });

  it('formats byte counts for the start notice', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
  });

  it('rejects a value-taking flag with no value', () => {
    const result = extractUploadFlags(['--mime']);
    expect(result).toEqual({ ok: false, message: 'Flag --mime requires a value.' });
  });
});

describe('createFilesUploadHandler', () => {
  it('exits 2 when the path is missing, never reading or calling the SDK', async () => {
    const d = deps();
    const { sdk, invoke } = fakeUploadSdk();
    const code = await createFilesUploadHandler(d)(createFakeContext({ sdk }), commandIntent(['--drive', 'drv_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(d.readFile).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('exits 2 when --drive is missing', async () => {
    const d = deps();
    const { sdk, invoke } = fakeUploadSdk();
    const code = await createFilesUploadHandler(d)(createFakeContext({ sdk }), commandIntent(['./clip.mp4']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('exits 2 asking for --mime when the extension is unknown, rather than guessing', async () => {
    const d = deps();
    const { sdk, invoke } = fakeUploadSdk();
    const { ctx, out, err } = makeCtx(sdk);
    const code = await createFilesUploadHandler(d)(ctx, commandIntent(['./thing.xyz', '--drive', 'drv_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(invoke).not.toHaveBeenCalled();
    expect(err()).toContain('--mime');
  });

  it('uploads and reports the created page', async () => {
    const d = deps();
    const { sdk, calls } = fakeUploadSdk();
    const { ctx, out, err } = makeCtx(sdk);
    vi.stubGlobal('fetch', okFetch());

    const code = await createFilesUploadHandler(d)(ctx, commandIntent(['./clip.mp4', '--drive', 'drv_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(d.readFile).toHaveBeenCalledWith('./clip.mp4');
    expect(calls).toEqual(['uploads.presign', 'uploads.complete']);
    expect(out()).toContain('pg_1');
    vi.unstubAllGlobals();
  });

  it('names the dedup case so a caller does not think the upload vanished', async () => {
    const d = deps();
    const { sdk } = fakeUploadSdk({ alreadyExists: true });
    const { ctx, out, err } = makeCtx(sdk);

    const code = await createFilesUploadHandler(d)(ctx, commandIntent(['./clip.mp4', '--drive', 'drv_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(out()).toContain('already stored');
  });

  it('emits a single parseable line under --json and no start notice', async () => {
    const d = deps();
    const { sdk } = fakeUploadSdk({ alreadyExists: true });
    const { ctx, out, err } = makeCtx(sdk);

    const code = await createFilesUploadHandler(d)(ctx, commandIntent(['./clip.mp4', '--drive', 'drv_1', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(out())).toEqual({
      pageId: 'pg_1',
      title: 'clip.mp4',
      driveId: 'drv_1',
      contentHash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      deduplicated: true,
    });
    expect(err()).toBe('');
  });

  it('exits 1 without touching the SDK when the file cannot be read', async () => {
    const d = deps(async () => {
      throw new Error('ENOENT');
    });
    const { sdk, invoke } = fakeUploadSdk();
    const { ctx, out, err } = makeCtx(sdk);

    const code = await createFilesUploadHandler(d)(ctx, commandIntent(['./missing.mp4', '--drive', 'drv_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(invoke).not.toHaveBeenCalled();
    expect(err()).toContain('ENOENT');
  });

  it('exits 1 and releases the slot when the upload fails mid-flight', async () => {
    const d = deps();
    const { sdk, calls } = fakeUploadSdk({ alreadyExists: true, failComplete: true });
    const { ctx, out, err } = makeCtx(sdk);

    const code = await createFilesUploadHandler(d)(ctx, commandIntent(['./clip.mp4', '--drive', 'drv_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(calls).toEqual(['uploads.presign', 'uploads.complete', 'uploads.cancel']);
  });
});
