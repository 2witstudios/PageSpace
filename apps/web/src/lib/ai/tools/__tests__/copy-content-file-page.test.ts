import { describe, it, expect, vi } from 'vitest';
import { ContentBlockedError } from '@pagespace/lib/content-safety/policy';
import type { AccessActor } from '@pagespace/lib/permissions/access-actor';
import { fileSandboxBytesIntoDrive, type FileIntoDriveEffects } from '../copy-content-file-page';
import { FileStorageQuotaError } from '@/lib/upload/create-file-page';

const ACTOR = { userId: 'u1' } as unknown as AccessActor;
const BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0xff]);
const PARENT = { id: 'folder1', title: 'Exhibits', type: 'FOLDER', contentMode: null, content: null, driveId: 'drive9' };

type CreateArgs = Parameters<FileIntoDriveEffects['createFilePage']>;

function effects(over: Partial<FileIntoDriveEffects> = {}) {
  const calls = {
    created: [] as CreateArgs[],
    stored: [] as unknown[],
    enqueued: [] as Array<[AccessActor, string, string]>,
    broadcasts: [] as unknown[],
  };
  const e: FileIntoDriveEffects = {
    createFilePage: async (input, deps) => {
      calls.created.push([input, deps]);
      // Drive the seams the way the real shell does: store, then commit, then afterCommit.
      await deps?.storeOriginal?.({
        contentHash: 'h'.repeat(64),
        buffer: input.buffer,
        mimeType: input.mimeType,
        title: input.title,
        pageId: 'newpage',
        driveId: input.targetDriveId as string,
        parentId: input.targetParentId ?? null,
      });
      await deps?.afterCommit?.({ pageId: 'newpage', driveId: input.targetDriveId as string });
      return { pageId: 'newpage', driveId: input.targetDriveId as string, parentId: input.targetParentId ?? null, contentHash: 'h'.repeat(64) };
    },
    storeOriginal: async (args) => {
      calls.stored.push(args);
    },
    enqueueProcessorJob: async (actor, driveId, pageId) => {
      calls.enqueued.push([actor, driveId, pageId]);
    },
    broadcast: async (payload) => {
      calls.broadcasts.push(payload);
    },
    logActivity: async () => {},
    logError: vi.fn(),
    ...over,
  };
  return { e, calls };
}

const run = (e: FileIntoDriveEffects, over: { title?: string; path?: string } = {}) =>
  fileSandboxBytesIntoDrive(
    { actor: ACTOR, parent: PARENT, title: over.title ?? 'Exhibit A.png', path: over.path ?? 'out/a.png', content: BYTES },
    e,
  );

describe('fileSandboxBytesIntoDrive', () => {
  it('files the bytes under the parent as a sandbox-copy FILE page with a declared type from the name', async () => {
    const { e, calls } = effects();
    const result = await run(e);
    expect(result).toEqual({ success: true, pageId: 'newpage', driveId: 'drive9', mimeType: 'image/png' });
    const [input] = calls.created[0];
    expect(input).toMatchObject({
      userId: 'u1',
      title: 'Exhibit A.png',
      mimeType: 'image/png',
      source: 'sandbox-copy',
      targetDriveId: 'drive9',
      targetParentId: 'folder1',
    });
    expect(Buffer.from(input.buffer).equals(Buffer.from(BYTES))).toBe(true);
  });

  it('stores the original THROUGH THE PROCESSOR (encryption at rest), with the actor and the new page id', async () => {
    const { e, calls } = effects();
    await run(e);
    expect(calls.stored).toHaveLength(1);
    expect(calls.stored[0]).toMatchObject({ actor: ACTOR, driveId: 'drive9', parentId: 'folder1', pageId: 'newpage', originalName: 'Exhibit A.png' });
  });

  it('enqueues the processor job for the new page once committed, and broadcasts its creation', async () => {
    const { e, calls } = effects();
    await run(e);
    expect(calls.enqueued).toEqual([[ACTOR, 'drive9', 'newpage']]);
    expect(calls.broadcasts[0]).toMatchObject({ driveId: 'drive9', pageId: 'newpage', operation: 'created', parentId: 'folder1', type: 'FILE' });
  });

  it('given an enqueue failure, should still report the committed page (best-effort, logged loudly)', async () => {
    const logError = vi.fn();
    const { e } = effects({ enqueueProcessorJob: async () => { throw new Error('processor down'); }, logError });
    const result = await run(e);
    expect(result.success).toBe(true);
    expect(logError).toHaveBeenCalled();
  });

  it('given a title with no known extension, should declare the type from the sandbox path', async () => {
    const { e, calls } = effects();
    const result = await run(e, { title: 'Exhibit A', path: 'out/a.pdf' });
    expect(result).toMatchObject({ success: true, mimeType: 'application/pdf' });
    expect(calls.created[0][0].mimeType).toBe('application/pdf');
  });

  it('given a name that declares a blocked type (html, svg, js), should refuse before storing anything', async () => {
    const { e, calls } = effects();
    const result = await run(e, { title: 'page.html', path: 'out/page.html' });
    expect(result.success).toBe(false);
    expect(calls.created).toHaveLength(0);
  });

  it('given a storage quota refusal, should explain it', async () => {
    const { e } = effects({
      createFilePage: async () => {
        throw new FileStorageQuotaError('File exceeds pro tier limit of 250 MB');
      },
    });
    const result = await run(e);
    expect(result).toMatchObject({ success: false, error: 'Storage limit reached', message: 'File exceeds pro tier limit of 250 MB' });
  });

  it('given blocked content, should refuse with the content-safety message', async () => {
    const { e } = effects({
      createFilePage: async () => {
        throw new ContentBlockedError('h'.repeat(64));
      },
    });
    const result = await run(e);
    expect(result).toMatchObject({ success: false, error: 'Content blocked' });
  });

  it('given a store failure, should refuse without claiming a page exists', async () => {
    const { e } = effects({
      createFilePage: async () => {
        throw new Error('Processor store failed with status 503');
      },
    });
    const result = await run(e);
    expect(result).toMatchObject({ success: false, error: 'Could not file the page' });
  });
});
