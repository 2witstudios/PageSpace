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
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { publishedPages } from '@pagespace/db/schema/published-pages';
import { filePages, files } from '@pagespace/db/schema/storage';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { suspendUser, unsuspendUser } from '../../auth/suspend-user';
import {
  CaseCategoryDowngradeError,
  CaseRunInProgressError,
  createTakedownCaseStore,
  listCasesDueForResweep,
  listCasesForTarget,
  listContentCases,
  openTakedownCase,
  withContentCaseRunLock,
} from '../case-store';
import { collectContentReferences } from '../references';
import { resolveTakedownTarget } from '../targets';

const freshHash = () => createHash('sha256').update(randomUUID()).digest('hex');

const HASH = freshHash();
const LEGACY_HASH = freshHash();
const CHAT_HASH = freshHash();
const run = createId().slice(0, 6).toLowerCase();
const SITE = `cs-${run}`;
const DOMAIN = `photos-${run}.example.test`;

const ids = { users: [] as string[], drives: [] as string[], cases: [] as string[] };
let uploader: string;
let linker: string;
let driveId: string;
let filePageId: string;
let legacyPageId: string;
let linkedPageId: string;
let chatMessageId: string;
let quotingMessageId: string;

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
    await db.insert(customDomains).values({ driveId, hostname: DOMAIN, status: 'active' });
    await db.insert(publishedPages).values({ driveId, pageId: filePageId, path: 'gallery/cat', artifactKey: `published/${SITE}/gallery/cat/index.html`, updatedAt: new Date() });

    const message = await factories.createChatMessage(linkedPageId, {
      userId: linker,
      content: JSON.stringify({ textParts: ['x'], fileParts: [{ storageKey: `chat-attachments/${CHAT_HASH}/original` }], partsOrder: [{ type: 'file' }] }),
    });
    chatMessageId = message.id;
    // Someone else only QUOTES the key, both as raw text and inside a real envelope's text part.
    const quoting = await factories.createChatMessage(linkedPageId, {
      conversationId: message.conversationId,
      userId: uploader,
      content: JSON.stringify({ textParts: [`"storageKey":"chat-attachments/${CHAT_HASH}/original"`], partsOrder: [{ index: 0, type: 'text' }] }),
    });
    quotingMessageId = quoting.id;
  });

  afterAll(async () => {
    if (ids.cases.length) await db.delete(contentCases).where(inArray(contentCases.id, ids.cases));
    await db.delete(contentBlocks).where(inArray(contentBlocks.contentHash, [HASH, LEGACY_HASH, CHAT_HASH]));
    await db.delete(files).where(eq(files.id, HASH));
    if (ids.drives.length) await db.delete(drives).where(inArray(drives.id, ids.drives));
    if (ids.users.length) await db.delete(users).where(inArray(users.id, ids.users));
  });

  describe('collectContentReferences', () => {
    it('finds pages by file path and by file link, the file row, the drive and the uploader', async () => {
      const refs = await collectContentReferences(HASH);

      expect(refs.pageIds.sort()).toEqual([filePageId, linkedPageId].sort());
      expect(refs.fileIds).toEqual([HASH]);
      expect(refs.driveIds).toEqual([driveId]);
      expect(refs.truncated).toBe(false);
      // Whoever only LINKED the stored file to another page did not bring the
      // bytes in: they are found through the page, not listed as an uploader.
      expect(refs.uploaderUserIds).toEqual([uploader]);
    });

    it('finds a page that stores the legacy files/<hash>/original form', async () => {
      const refs = await collectContentReferences(LEGACY_HASH);
      expect(refs.pageIds).toEqual([legacyPageId]);
    });

    it('finds an AI chat message by the attachment key in its body, and its author', async () => {
      const refs = await collectContentReferences(CHAT_HASH);
      expect(refs.aiMessageIds.sort()).toEqual([chatMessageId, quotingMessageId].sort());
      // Only the message that really attaches the file names an uploader; the one quoting its key does not.
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

    it('gives a reused case the new request\'s category, so re-filing as CSAM runs under the CSAM rule', async () => {
      const hash = freshHash();
      const first = await open({ targetId: hash, contentHash: hash, category: 'malware', takedown: { kind: 'global', skipPreservation: true, skipPreservationReason: 'known sample' } });
      const second = await open({ targetId: hash, contentHash: hash, category: 'csam' });

      expect(second.case.id).toBe(first.case.id);
      expect(second.case.category).toBe('csam');
    });

    describe('re-filing a case while a run holds it', () => {
      const skipMalware = (hash: string) =>
        open({ targetId: hash, contentHash: hash, category: 'malware', takedown: { kind: 'global', skipPreservation: true, skipPreservationReason: 'known sample' } });
      const categoryOf = async (caseId: string) =>
        (await db.select({ category: contentCases.category }).from(contentCases).where(eq(contentCases.id, caseId)))[0]?.category;

      it('waits for the run to finish, so the new category cannot land between its reload and a delete', async () => {
        const hash = freshHash();
        const first = await skipMalware(hash);
        let refile: Promise<Awaited<ReturnType<typeof open>>> | undefined;
        let whileRunning: string | null | undefined;

        await withContentCaseRunLock(first.case.id, async () => {
          // From another request, as an admin re-filing the case would.
          refile = open({ targetId: hash, contentHash: hash, category: 'csam' });
          await new Promise((resolve) => setTimeout(resolve, 200));
          whileRunning = await categoryOf(first.case.id);
        });
        const second = await refile;

        expect(whileRunning).toBe('malware');
        expect(second).toMatchObject({ created: false, case: { id: first.case.id, category: 'csam' } });
        expect(second?.case.snapshot?.takedown?.skipPreservation).toBe(false);
      });

      it('gives up after the timeout and changes nothing', async () => {
        const hash = freshHash();
        const first = await skipMalware(hash);

        await withContentCaseRunLock(first.case.id, async () => {
          await expect(
            openTakedownCase(
              { targetType: 'content_hash', targetId: hash, contentHash: hash, category: 'csam', reason: 'r', takedown: { kind: 'global' } },
              { lockTimeoutMs: 50 },
            ),
          ).rejects.toBeInstanceOf(CaseRunInProgressError);
        });

        expect(await categoryOf(first.case.id)).toBe('malware');
      });

      it('applies two concurrent re-files of the same case one after the other, to the same case', async () => {
        const hash = freshHash();
        const first = await skipMalware(hash);
        const [a, b] = await Promise.all([
          open({ targetId: hash, contentHash: hash, category: 'csam' }),
          open({ targetId: hash, contentHash: hash, category: 'csam', takedown: { kind: 'global', actorUserId: 'admin-1', suspendUploader: true } }),
        ]);

        expect([a.case.id, b.case.id]).toEqual([first.case.id, first.case.id]);
        const [row] = await db.select().from(contentCases).where(eq(contentCases.id, first.case.id));
        expect(row.category).toBe('csam');
        expect(row.snapshot?.takedown?.suspendUploader).toBe(true);
      });
    });

    it('refuses to re-file an open CSAM case under another category: that would be a way around preservation', async () => {
      const hash = freshHash();
      const first = await open({ targetId: hash, contentHash: hash, category: 'csam' });

      await expect(
        open({ targetId: hash, contentHash: hash, category: 'malware', takedown: { kind: 'global', skipPreservation: true, skipPreservationReason: 'x' } }),
      ).rejects.toBeInstanceOf(CaseCategoryDowngradeError);

      const [row] = await db.select().from(contentCases).where(eq(contentCases.id, first.case.id));
      expect(row.category).toBe('csam');
      expect(row.snapshot?.takedown?.skipPreservation).not.toBe(true);
    });

    it('refuses a non-CSAM global case on a hash already blocked as CSAM, even after the CSAM case finished', async () => {
      const hash = freshHash();
      await createTakedownCaseStore().upsertBlock({ contentHash: hash, category: 'csam', source: 'admin', caseId: 'finished-case', createdBy: null });

      await expect(
        open({ targetId: hash, contentHash: hash, category: 'malware', takedown: { kind: 'global', skipPreservation: true, skipPreservationReason: 'x' } }),
      ).rejects.toBeInstanceOf(CaseCategoryDowngradeError);
      await expect(open({ targetId: hash, contentHash: hash, category: 'csam' })).resolves.toMatchObject({ created: true });
      await db.delete(contentBlocks).where(eq(contentBlocks.contentHash, hash));
    });

    it('marks a hash CSAM for good once any case says so, so a later malware case on it is refused', async () => {
      const store = createTakedownCaseStore();
      const hash = freshHash();
      // First blocked as malware...
      await store.upsertBlock({ contentHash: hash, category: 'malware', source: 'admin', caseId: 'case-m', createdBy: null });
      // ...then a CSAM case blocks the same hash.
      await store.upsertBlock({ contentHash: hash, category: 'csam', source: 'admin', caseId: 'case-c', createdBy: null });

      const [block] = await db.select().from(contentBlocks).where(eq(contentBlocks.contentHash, hash));
      expect(block).toMatchObject({ category: 'csam', caseId: 'case-m' });
      await expect(
        open({ targetId: hash, contentHash: hash, category: 'malware', takedown: { kind: 'global', skipPreservation: true, skipPreservationReason: 'x' } }),
      ).rejects.toBeInstanceOf(CaseCategoryDowngradeError);
      await db.delete(contentBlocks).where(eq(contentBlocks.contentHash, hash));
    });

    it('upgrades the block row when an open malware case is re-filed as CSAM', async () => {
      const store = createTakedownCaseStore();
      const hash = freshHash();
      await open({ targetId: hash, contentHash: hash, category: 'malware' });
      await store.upsertBlock({ contentHash: hash, category: 'malware', source: 'admin', caseId: 'case-m', createdBy: null });

      await open({ targetId: hash, contentHash: hash, category: 'csam' });

      const [block] = await db.select().from(contentBlocks).where(eq(contentBlocks.contentHash, hash));
      expect(block.category).toBe('csam');
      await db.delete(contentBlocks).where(eq(contentBlocks.contentHash, hash));
    });

    it('lets the latest request withdraw a skip, and keeps a suspension once asked for', async () => {
      const hash = freshHash();
      await open({ targetId: hash, contentHash: hash, takedown: { kind: 'global', skipPreservation: true, skipPreservationReason: 'known sample', suspendUploader: true } });
      const second = await open({ targetId: hash, contentHash: hash, takedown: { kind: 'global' } });

      expect(second.case.snapshot?.takedown).toMatchObject({ skipPreservation: false, suspendUploader: true });
      expect(second.case.snapshot?.takedown?.skipPreservationReason).toBeUndefined();
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

    it('writes the block once and keeps the first one (a later non-CSAM category does not replace it)', async () => {
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

    describe('listCasesDueForResweep', () => {
      const window = () => ({ quietBefore: new Date(Date.now() + 1000), notOlderThan: new Date(Date.now() - 60_000), maxAttempts: 3, limit: 200 });
      const due = async () => (await listCasesDueForResweep(window())).map((c) => c.id);
      const finished = async () => {
        const hash = freshHash();
        const { case: row } = await open({ targetId: hash, contentHash: hash });
        await store.setStatus(row.id, 'actioned');
        return row.id;
      };
      const store = createTakedownCaseStore();

      it('offers a finished global case, and not again once a pass completed', async () => {
        const id = await finished();
        expect(await due()).toContain(id);

        await store.mergeSnapshot(id, { resweep: { attempts: 1, done: true } });
        expect(await due()).not.toContain(id);
      });

      it('keeps offering a case whose re-sweep failed, until the attempt cap', async () => {
        const id = await finished();
        await store.setStatus(id, 'open');
        await store.mergeSnapshot(id, { resweep: { attempts: 1, done: false } });
        expect(await due()).toContain(id);

        await store.mergeSnapshot(id, { resweep: { attempts: 3, done: false } });
        expect(await due()).not.toContain(id);
      });

      it('does not offer an open case that has never been swept: that one is resumed, not swept', async () => {
        const hash = freshHash();
        const { case: row } = await open({ targetId: hash, contentHash: hash });
        expect(await due()).not.toContain(row.id);
      });

      it('waits for the quiet window', async () => {
        const id = await finished();
        const early = { ...window(), quietBefore: new Date(Date.now() - 30_000) };
        expect((await listCasesDueForResweep(early)).map((c) => c.id)).not.toContain(id);
      });
    });
  });

  describe('withContentCaseRunLock', () => {
    const caseA = `lock-a-${run}`;
    const caseB = `lock-b-${run}`;

    it('lets one run hold a case at a time, without blocking another case, and frees it afterwards', async () => {
      let second: unknown;
      let other: unknown;
      const first = await withContentCaseRunLock(caseA, async () => {
        // From another connection, as a second web instance or the cron would.
        second = await withContentCaseRunLock(caseA, async () => 'second run');
        other = await withContentCaseRunLock(caseB, async () => 'another case');
        return 'first run';
      });

      expect(first).toEqual({ acquired: true, value: 'first run' });
      expect(second).toEqual({ acquired: false });
      expect(other).toEqual({ acquired: true, value: 'another case' });
      expect(await withContentCaseRunLock(caseA, async () => 'later run')).toEqual({ acquired: true, value: 'later run' });
    });

    it('frees the lock when the run throws', async () => {
      await expect(withContentCaseRunLock(caseA, async () => { throw new Error('step blew up'); })).rejects.toThrow('step blew up');
      expect(await withContentCaseRunLock(caseA, async () => 'next')).toEqual({ acquired: true, value: 'next' });
    });

    it('is what the case store hands the takedown', () => {
      expect(createTakedownCaseStore().withCaseLock).toBe(withContentCaseRunLock);
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

    it('resolves a published URL to its page, as a page target', async () => {
      const resolved = await resolveTakedownTarget(`https://${SITE}.pagespace.site/Gallery/cat/`);
      expect(resolved).toMatchObject({ targetType: 'page', targetId: filePageId, page: { id: filePageId }, drive: { id: driveId }, contentHash: HASH });
    });

    it('resolves a published URL with no matching page to its drive', async () => {
      const resolved = await resolveTakedownTarget(`https://${SITE}.pagespace.site/no/such/page`);
      expect(resolved).toMatchObject({ targetType: 'drive', targetId: driveId, page: null, contentHash: null });
    });

    it('resolves a registered custom domain to its drive', async () => {
      expect(await resolveTakedownTarget(`https://${DOMAIN}/gallery/cat`)).toMatchObject({ targetType: 'page', targetId: filePageId, drive: { id: driveId } });
    });

    // Only `<subdomain>.pagespace.site` names a drive by its first label. Anywhere else the first label is
    // someone else's text: taking it as a subdomain would hand the admin another tenant's drive to act on.
    it.each([
      ['a foreign host whose first label is a real subdomain', () => `https://${SITE}.evil.test/gallery/cat`],
      ['www. in front of a registered custom domain', () => `https://www.${DOMAIN}/gallery/cat`],
      ['an unregistered custom domain', () => `https://unregistered-${run}.example.test/`],
      ['a host nested under a real subdomain', () => `https://a.${SITE}.pagespace.site/gallery/cat`],
      ['a look-alike publish host', () => `https://${SITE}.pagespace.site.evil.test/gallery/cat`],
    ])('resolves nothing for %s', async (_label, input) => {
      expect(await resolveTakedownTarget(input())).toBeNull();
    });

    it('resolves a public asset URL to its content hash', async () => {
      expect(await resolveTakedownTarget(`https://cdn.example.test/assets/${HASH}`)).toMatchObject({ targetType: 'content_hash', targetId: HASH });
    });

    it('resolves a user ID, and reports the block once the hash is blocked', async () => {
      expect(await resolveTakedownTarget(uploader)).toMatchObject({ targetType: 'user', user: { id: uploader, suspended: false, hasAvatar: false, hasUploadedAvatar: false } });

      await createTakedownCaseStore().upsertBlock({ contentHash: HASH, category: 'malware', source: 'admin', caseId: 'case-z', createdBy: null });
      expect((await resolveTakedownTarget(HASH))?.block).toMatchObject({ category: 'malware', caseId: 'case-z' });
    });

    it.each([
      ['a page ID', () => filePageId],
      ['a published URL', () => `https://${SITE}.pagespace.site/gallery/cat`],
      ['a published URL with no matching page', () => `https://${SITE}.pagespace.site/elsewhere`],
      ['a public asset URL', () => `https://cdn.example.test/assets/${HASH}`],
    ])('never returns a title, filename or URL, given %s', async (_label, input) => {
      const resolved = await resolveTakedownTarget(input());
      expect(resolved).not.toBeNull();
      const json = JSON.stringify(resolved);
      expect(json).not.toMatch(/title|fileName|filename|https?:|pagespace\.site|example\.test/i);
    });

    it('returns null for input that matches nothing', async () => {
      expect(await resolveTakedownTarget('no-such-thing')).toBeNull();
      expect(await resolveTakedownTarget('   ')).toBeNull();
      expect(await resolveTakedownTarget('https://nobody-here.example.test/x')).toBeNull();
    });

    it('does not throw on a URL with a malformed escape', async () => {
      await expect(resolveTakedownTarget(`https://${SITE}.pagespace.site/bad%zzpath`)).resolves.toMatchObject({ targetType: 'drive', page: null });
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
