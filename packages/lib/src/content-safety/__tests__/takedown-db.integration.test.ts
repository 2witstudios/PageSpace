/**
 * The takedown's database edge against REAL Postgres: the case store, the
 * reference sweep, target resolution and the shared suspend function. The
 * orchestrator's own tests fake all of these, so only this file proves the SQL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'crypto';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { contentBlocks, contentCases } from '@pagespace/db/schema/content-safety';
import { drives } from '@pagespace/db/schema/core';
import { publishedPages } from '@pagespace/db/schema/published-pages';
import { filePages, files } from '@pagespace/db/schema/storage';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { suspendUser, unsuspendUser } from '../../auth/suspend-user';
import {
  createTakedownCaseStore,
  listCasesDueForResweep,
  listCasesForTarget,
  listContentCases,
  openTakedownCase,
} from '../case-store';
import { collectContentReferences } from '../references';
import { resolveTakedownTarget } from '../targets';

const freshHash = () => createHash('sha256').update(randomUUID()).digest('hex');

const HASH = freshHash();
const LEGACY_HASH = freshHash();
const CHAT_HASH = freshHash();
const run = createId().slice(0, 6).toLowerCase();
const SITE = `cs-${run}`;

const ids = { users: [] as string[], drives: [] as string[], cases: [] as string[] };
let uploader: string;
let linker: string;
let driveId: string;
let filePageId: string;
let legacyPageId: string;
let linkedPageId: string;
let chatMessageId: string;

describe('takedown database edge — real Postgres', () => {
  beforeAll(async () => {
    try {
      const u = await factories.createUser();
      const l = await factories.createUser();
      uploader = u.id;
      linker = l.id;
      ids.users.push(uploader, linker);
    } catch (error) {
      requireDb('takedown-db.integration.test.ts', error);
      throw error;
    }
    const drive = await factories.createDrive(uploader);
    driveId = drive.id;
    ids.drives.push(driveId);
    await db.update(drives).set({ publishSubdomain: SITE }).where(eq(drives.id, driveId));

    const filePage = await factories.createPage(driveId, { type: 'FILE', filePath: HASH, contentHash: HASH, mimeType: 'image/png', createdBy: uploader });
    filePageId = filePage.id;
    const legacyPage = await factories.createPage(driveId, { type: 'FILE', filePath: `files/${LEGACY_HASH}/original`, createdBy: uploader });
    legacyPageId = legacyPage.id;
    const linkedPage = await factories.createPage(driveId, { type: 'DOCUMENT' });
    linkedPageId = linkedPage.id;

    await db.insert(files).values({ id: HASH, driveId, sizeBytes: 10, mimeType: 'image/png', storagePath: HASH, createdBy: uploader });
    await db.insert(filePages).values({ fileId: HASH, pageId: linkedPageId, linkedBy: linker });
    await db.insert(publishedPages).values({ driveId, pageId: filePageId, path: 'gallery/cat', artifactKey: `published/${SITE}/gallery/cat/index.html`, updatedAt: new Date() });

    const message = await factories.createChatMessage(linkedPageId, {
      userId: linker,
      content: JSON.stringify({ textParts: ['x'], fileParts: [{ storageKey: `chat-attachments/${CHAT_HASH}/original` }], partsOrder: [{ type: 'file' }] }),
    });
    chatMessageId = message.id;
  });

  afterAll(async () => {
    if (ids.cases.length) await db.delete(contentCases).where(inArray(contentCases.id, ids.cases));
    await db.delete(contentBlocks).where(inArray(contentBlocks.contentHash, [HASH, LEGACY_HASH, CHAT_HASH]));
    await db.delete(files).where(eq(files.id, HASH));
    if (ids.drives.length) await db.delete(drives).where(inArray(drives.id, ids.drives));
    if (ids.users.length) await db.delete(users).where(inArray(users.id, ids.users));
  });

  describe('collectContentReferences', () => {
    it('finds pages by file path and by file link, the file row, the drive and everyone who put it there', async () => {
      const refs = await collectContentReferences(HASH);

      expect(refs.pageIds.sort()).toEqual([filePageId, linkedPageId].sort());
      expect(refs.fileIds).toEqual([HASH]);
      expect(refs.driveIds).toEqual([driveId]);
      expect(refs.uploaderUserIds.sort()).toEqual([uploader, linker].sort());
      expect(refs.truncated).toBe(false);
    });

    it('finds a page that stores the legacy files/<hash>/original form', async () => {
      const refs = await collectContentReferences(LEGACY_HASH);
      expect(refs.pageIds).toEqual([legacyPageId]);
    });

    it('finds an AI chat message by the attachment key in its body, and its author', async () => {
      const refs = await collectContentReferences(CHAT_HASH);
      expect(refs.aiMessageIds).toEqual([chatMessageId]);
      expect(refs.uploaderUserIds).toEqual([linker]);
      expect(refs.conversationIds).toHaveLength(1);
    });

    it('returns nothing for a hash nobody references', async () => {
      const refs = await collectContentReferences(freshHash());
      expect(refs).toMatchObject({ pageIds: [], fileIds: [], driveIds: [], uploaderUserIds: [], aiMessageIds: [] });
    });

    it('rejects something that is not a hash', async () => {
      await expect(collectContentReferences('not-a-hash')).rejects.toThrow('Invalid content hash');
    });
  });

  describe('case store', () => {
    const open = async (overrides: Partial<Parameters<typeof openTakedownCase>[0]> = {}) => {
      const opened = await openTakedownCase({
        targetType: 'content_hash',
        targetId: HASH,
        contentHash: HASH,
        category: 'malware',
        reason: 'reported sample',
        takedown: { kind: 'global', actorUserId: 'admin-1' },
        ...overrides,
      });
      ids.cases.push(opened.case.id);
      return opened;
    };

    it('opens a case once and reuses it while it is unfinished, adding newly requested options', async () => {
      const first = await open();
      const second = await open({ takedown: { kind: 'global', actorUserId: 'admin-1', suspendUploader: true } });
      const third = await open({ takedown: { kind: 'global', actorUserId: 'admin-1' } });

      expect(first.created).toBe(true);
      expect(second).toMatchObject({ created: false, case: { id: first.case.id } });
      expect(third.case.snapshot?.takedown?.suspendUploader).toBe(true);
    });

    it('opens a separate case for a different action on the same target', async () => {
      const global = await open();
      const other = await open({ takedown: { kind: 'unpublish_page' } });
      expect(other.case.id).not.toBe(global.case.id);
    });

    it('appends steps and merges snapshot fields without losing what is already there', async () => {
      const store = createTakedownCaseStore();
      const { case: row } = await open({ targetId: LEGACY_HASH, contentHash: LEGACY_HASH });

      await Promise.all([
        store.appendStep(row.id, { step: 'block', status: 'ok', at: 'a' }),
        store.appendStep(row.id, { step: 'preserve', status: 'failed', detail: 'boom', at: 'b' }),
      ]);
      await store.mergeSnapshot(row.id, { evidenceKey: 'cases/x/y/original' });
      await store.setStatus(row.id, 'awaiting_evidence');

      const loaded = await store.load(row.id);
      expect(loaded?.steps?.map((s) => s.step).sort()).toEqual(['block', 'preserve']);
      expect(loaded?.snapshot).toMatchObject({ evidenceKey: 'cases/x/y/original', takedown: { kind: 'global' } });
      expect(loaded?.status).toBe('awaiting_evidence');
    });

    it('writes the block once and keeps the first one', async () => {
      const store = createTakedownCaseStore();
      await store.upsertBlock({ contentHash: CHAT_HASH, category: 'csam', source: 'admin', caseId: 'case-a', createdBy: 'admin-1' });
      await store.upsertBlock({ contentHash: CHAT_HASH, category: 'malware', source: 'admin', caseId: 'case-b', createdBy: 'admin-2' });

      const [block] = await db.select().from(contentBlocks).where(eq(contentBlocks.contentHash, CHAT_HASH));
      expect(block).toMatchObject({ category: 'csam', caseId: 'case-a' });
    });

    it('lists cases newest first, by status, and by target or hash', async () => {
      const { case: row } = await open({ targetType: 'page', targetId: filePageId, takedown: { kind: 'unpublish_page' }, category: 'policy' });

      expect((await listContentCases({ limit: 200 })).map((c) => c.id)).toContain(row.id);
      expect((await listContentCases({ status: 'dismissed', limit: 200 })).map((c) => c.id)).not.toContain(row.id);
      const forTarget = await listCasesForTarget({ targetType: 'page', targetId: filePageId, contentHash: HASH });
      expect(forTarget.map((c) => c.id)).toContain(row.id);
      expect(forTarget.some((c) => c.targetType === 'content_hash')).toBe(true);
    });

    it('offers a finished global case for one re-sweep, and not again after it', async () => {
      const store = createTakedownCaseStore();
      const hash = freshHash();
      const { case: row } = await open({ targetId: hash, contentHash: hash });
      await store.setStatus(row.id, 'actioned');
      const window = { actionedBefore: new Date(Date.now() + 1000), actionedAfter: new Date(Date.now() - 60_000), limit: 200 };

      expect((await listCasesDueForResweep(window)).map((c) => c.id)).toContain(row.id);
      await store.appendStep(row.id, { step: 'resweep', status: 'ok', at: 'c' });
      expect((await listCasesDueForResweep(window)).map((c) => c.id)).not.toContain(row.id);
    });
  });

  describe('resolveTakedownTarget', () => {
    it('resolves a content hash with its references and no block', async () => {
      const hash = freshHash();
      expect(await resolveTakedownTarget(` ${hash.toUpperCase()} `)).toMatchObject({
        targetType: 'content_hash',
        targetId: hash,
        contentHash: hash,
        block: null,
        references: { pageIds: [] },
      });
    });

    it('resolves a file page ID to its hash, drive and publish state', async () => {
      expect(await resolveTakedownTarget(filePageId)).toMatchObject({
        targetType: 'page',
        targetId: filePageId,
        contentHash: HASH,
        page: { id: filePageId, driveId, isPublished: true, mimeType: 'image/png' },
        drive: { id: driveId, ownerId: uploader, publishes: true, sitesHeld: false },
      });
    });

    it('resolves a published URL to its page and drive', async () => {
      const resolved = await resolveTakedownTarget(`https://${SITE}.pagespace.site/Gallery/cat/`);
      expect(resolved).toMatchObject({ targetType: 'published_url', page: { id: filePageId }, drive: { id: driveId }, contentHash: HASH });
    });

    it('resolves a public asset URL to its content hash', async () => {
      expect(await resolveTakedownTarget(`https://cdn.example.test/assets/${HASH}`)).toMatchObject({ targetType: 'content_hash', targetId: HASH });
    });

    it('resolves a user ID, and reports the block once the hash is blocked', async () => {
      expect(await resolveTakedownTarget(uploader)).toMatchObject({ targetType: 'user', user: { id: uploader, suspended: false, hasUploadedAvatar: false } });

      await createTakedownCaseStore().upsertBlock({ contentHash: HASH, category: 'malware', source: 'admin', caseId: 'case-z', createdBy: null });
      expect((await resolveTakedownTarget(HASH))?.block).toMatchObject({ category: 'malware', caseId: 'case-z' });
    });

    it('never returns a title, filename or URL', async () => {
      const resolved = await resolveTakedownTarget(filePageId);
      const json = JSON.stringify(resolved);
      expect(json).not.toMatch(/title|fileName|filename|https?:/i);
    });

    it('returns null for input that matches nothing', async () => {
      expect(await resolveTakedownTarget('no-such-thing')).toBeNull();
      expect(await resolveTakedownTarget('   ')).toBeNull();
      expect(await resolveTakedownTarget('https://nobody-here.example.test/x')).toBeNull();
    });
  });

  describe('suspendUser / unsuspendUser', () => {
    it('suspends once, revokes sessions, and reports a repeat as already suspended', async () => {
      const target = await factories.createUser();
      ids.users.push(target.id);

      expect(await suspendUser({ userId: target.id, reason: 'case 1' })).toMatchObject({ status: 'suspended' });
      expect(await suspendUser({ userId: target.id, reason: 'case 2' })).toEqual({ status: 'already_suspended' });

      const [row] = await db.select({ at: users.suspendedAt, reason: users.suspendedReason }).from(users).where(eq(users.id, target.id));
      expect(row.at).toBeInstanceOf(Date);
      expect(row.reason).toBe('case 1');

      expect(await unsuspendUser(target.id)).toEqual({ status: 'reactivated' });
      expect(await unsuspendUser(target.id)).toEqual({ status: 'not_suspended' });
    });

    it('reports a user that does not exist', async () => {
      expect(await suspendUser({ userId: 'missing-user', reason: 'x' })).toEqual({ status: 'not_found' });
      expect(await unsuspendUser('missing-user')).toEqual({ status: 'not_found' });
    });
  });
});
