/**
 * `uploadFile` behaviour, focused on the four things the server contract makes
 * easy to get wrong: the dedup branch still creating a page, the slot always
 * being released on failure, the PUT carrying the exact declared media type,
 * and the cross-tenant 409 never being mistaken for dedup.
 */
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { Operation } from '../../registry/define.js';
import {
  computeContentHash,
  StorageUploadError,
  uploadFile,
  type OperationInvoker,
} from '../upload-file.js';

const HELLO_SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

const PAGE = {
  id: 'pg_1',
  title: 'clip.mp4',
  type: 'FILE',
  driveId: 'drv_1',
  parentId: null,
  position: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  isTrashed: false,
  fileSize: 5,
  mimeType: 'video/mp4',
  originalFileName: 'clip.mp4',
  contentHash: HELLO_SHA256,
  processingStatus: 'pending',
} as const;

interface RecordedCall {
  readonly name: string;
  readonly input: unknown;
}

/**
 * Stub invoker keyed by operation name. Each handler runs once per call, so a
 * test can assert on both what was sent and — via `calls` — what was NOT.
 */
function stubClient(handlers: Record<string, (input: unknown) => unknown>): {
  client: OperationInvoker;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client: OperationInvoker = {
    invoke<TIn extends z.ZodType, TOut extends z.ZodType>(
      op: Operation<string, TIn, TOut>,
      input: z.infer<TIn>,
    ): Promise<z.infer<TOut>> {
      calls.push({ name: op.name, input });
      const handler = handlers[op.name];
      if (!handler) throw new Error(`unexpected operation ${op.name}`);
      return Promise.resolve(handler(input) as z.infer<TOut>);
    },
  };
  return { client, calls };
}

function okFetch() {
  return vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
}

const BYTES = new TextEncoder().encode('hello');

describe('computeContentHash', () => {
  it('produces the lowercase-hex SHA-256 the server content-addresses on', async () => {
    await expect(computeContentHash(BYTES)).resolves.toBe(HELLO_SHA256);
  });

  it('hashes only the view, not the whole backing buffer', async () => {
    const backing = new TextEncoder().encode('xxhelloxx');
    const view = backing.subarray(2, 7);
    await expect(computeContentHash(view)).resolves.toBe(HELLO_SHA256);
  });
});

describe('uploadFile', () => {
  it('presigns, PUTs the bytes, then completes — and reports the page', async () => {
    const doFetch = okFetch();
    const { client, calls } = stubClient({
      'uploads.presign': () => ({ url: 'https://storage.example/put', jobId: 'job_1', key: 'k', expiresAt: 'later' }),
      'uploads.complete': () => ({ success: true, page: PAGE }),
    });

    const result = await uploadFile(
      client,
      { driveId: 'drv_1', bytes: BYTES, filename: 'clip.mp4', mimeType: 'video/mp4' },
      { fetch: doFetch },
    );

    expect(result.page).toEqual(PAGE);
    expect(result.contentHash).toBe(HELLO_SHA256);
    expect(result.deduplicated).toBe(false);
    expect(calls.map((c) => c.name)).toEqual(['uploads.presign', 'uploads.complete']);
    expect(calls[0].input).toMatchObject({ contentHash: HELLO_SHA256, fileSize: 5, mimeType: 'video/mp4' });
    // The title defaults to the filename rather than being sent empty.
    expect(calls[1].input).toMatchObject({ jobId: 'job_1', title: 'clip.mp4' });
  });

  it('sends the PUT with the declared media type verbatim, because the signature covers it', async () => {
    const doFetch = okFetch();
    const { client } = stubClient({
      'uploads.presign': () => ({ url: 'https://storage.example/put', jobId: 'job_1', key: 'k', expiresAt: 'later' }),
      'uploads.complete': () => ({ success: true, page: PAGE }),
    });

    await uploadFile(
      client,
      { driveId: 'drv_1', bytes: BYTES, filename: 'clip.mp4', mimeType: 'video/mp4' },
      { fetch: doFetch },
    );

    const [url, init] = (doFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://storage.example/put');
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ 'Content-Type': 'video/mp4' });
  });

  it('still completes on the dedup fast path, and sends no bytes', async () => {
    const doFetch = okFetch();
    const { client, calls } = stubClient({
      'uploads.presign': () => ({ alreadyExists: true, jobId: 'job_1', key: 'k' }),
      'uploads.complete': () => ({ success: true, page: PAGE }),
    });

    const result = await uploadFile(
      client,
      { driveId: 'drv_1', bytes: BYTES, filename: 'clip.mp4', mimeType: 'video/mp4' },
      { fetch: doFetch },
    );

    expect(result.deduplicated).toBe(true);
    expect(result.page).toEqual(PAGE);
    expect(doFetch).not.toHaveBeenCalled();
    // The page is created on this branch too — skipping complete here is the bug this guards.
    expect(calls.map((c) => c.name)).toContain('uploads.complete');
  });

  it('releases the reserved slot when storage rejects the bytes', async () => {
    const doFetch = vi.fn(async () => new Response('denied', { status: 403 })) as unknown as typeof fetch;
    const { client, calls } = stubClient({
      'uploads.presign': () => ({ url: 'https://storage.example/put', jobId: 'job_1', key: 'k', expiresAt: 'later' }),
      'uploads.cancel': () => ({ success: true }),
    });

    await expect(
      uploadFile(client, { driveId: 'drv_1', bytes: BYTES, filename: 'c.mp4', mimeType: 'video/mp4' }, { fetch: doFetch }),
    ).rejects.toBeInstanceOf(StorageUploadError);

    expect(calls.map((c) => c.name)).toEqual(['uploads.presign', 'uploads.cancel']);
    expect(calls[1].input).toEqual({ jobId: 'job_1' });
  });

  it('releases the reserved slot when complete fails, and surfaces the original error', async () => {
    const doFetch = okFetch();
    const boom = new Error('complete exploded');
    const { client, calls } = stubClient({
      'uploads.presign': () => ({ url: 'https://storage.example/put', jobId: 'job_1', key: 'k', expiresAt: 'later' }),
      'uploads.complete': () => {
        throw boom;
      },
      'uploads.cancel': () => ({ success: true }),
    });

    await expect(
      uploadFile(client, { driveId: 'drv_1', bytes: BYTES, filename: 'c.mp4', mimeType: 'video/mp4' }, { fetch: doFetch }),
    ).rejects.toBe(boom);

    expect(calls.map((c) => c.name)).toEqual(['uploads.presign', 'uploads.complete', 'uploads.cancel']);
  });

  it('does not mask the real failure when the cancel itself fails', async () => {
    const doFetch = vi.fn(async () => new Response('denied', { status: 403 })) as unknown as typeof fetch;
    const { client } = stubClient({
      'uploads.presign': () => ({ url: 'https://storage.example/put', jobId: 'job_1', key: 'k', expiresAt: 'later' }),
      'uploads.cancel': () => {
        throw new Error('cancel also failed');
      },
    });

    await expect(
      uploadFile(client, { driveId: 'drv_1', bytes: BYTES, filename: 'c.mp4', mimeType: 'video/mp4' }, { fetch: doFetch }),
    ).rejects.toBeInstanceOf(StorageUploadError);
  });

  it('propagates the cross-tenant 409 from presign without reserving or cancelling anything', async () => {
    const doFetch = okFetch();
    const claim = new Error('409 cross-tenant claim');
    const { client, calls } = stubClient({
      'uploads.presign': () => {
        throw claim;
      },
    });

    await expect(
      uploadFile(client, { driveId: 'drv_1', bytes: BYTES, filename: 'c.mp4', mimeType: 'video/mp4' }, { fetch: doFetch }),
    ).rejects.toBe(claim);

    // No slot was ever handed out, so there is nothing to cancel.
    expect(calls.map((c) => c.name)).toEqual(['uploads.presign']);
    expect(doFetch).not.toHaveBeenCalled();
  });
});
