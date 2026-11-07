/**
 * The content lock against a REAL Postgres: the two-revision rule, the guarded
 * write, and the row lock cannot be proved with a mocked database.
 *
 * WHY THIS TEST EXISTS. A person editing alone was told someone else had saved,
 * because a rename moved the one revision content saves were checked against.
 * Separating the two also removes what stopped a rename and a save racing, so the
 * concurrent cases below matter as much as the sequential ones.
 *
 * Every drive and user row is deleted; the pool is ended.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq, inArray, sql } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
// Page writes snapshot content to object storage (no credentials here): only
// those two storage calls are stubbed; page rows and their revisions stay real.
vi.mock('@pagespace/lib/services/page-version-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-version-service')>()),
  createPageVersion: vi.fn(async () => ({ id: 'test-version', contentRef: 'test-ref', contentSize: 0, compressed: false })),
}));
vi.mock('@pagespace/lib/services/page-content-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-content-store')>()),
  writePageContent: vi.fn(async (content: string, format: string) => ({ ref: `${format}:test-${content.length}`, size: content.length })),
}));
vi.mock('@pagespace/lib/monitoring/activity-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/monitoring/activity-logger')>()),
  getActorInfo: vi.fn(async () => ({ actorEmail: 'a@x', actorDisplayName: 'A' })),
}));

import { createPageVersion } from '@pagespace/lib/services/page-version-service';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';
import { applyPageMutation } from '../page-mutation-service';
import { pageService } from '../page-service';
import { appendRows, applyFormatOps, deleteRows, materializeFromDocument, readSheetDocument, setCells } from '@pagespace/lib/sheets/store';
import { serializeSheetContent, parseSheetContent } from '@pagespace/lib/sheets/io';

const createdDrives: string[] = [];
const createdUsers: string[] = [];
let userId: string;
let driveId: string;
let pageId: string;

const read = async () => {
  const [row] = await db
    .select({
      title: pages.title,
      content: pages.content,
      revision: pages.revision,
      contentRevision: pages.contentRevision,
    })
    .from(pages)
    .where(eq(pages.id, pageId));
  return row;
};

const update = (updates: Parameters<typeof pageService.updatePage>[2], expectedContentRevision?: number) =>
  pageService.updatePage(pageId, credentialActor(userId, null), updates, {
    expectedContentRevision,
    skipPermissionCheck: true,
  });

describe('the content lock against real Postgres', () => {
  beforeAll(async () => {
    try {
      const user = await factories.createUser();
      userId = user.id;
      createdUsers.push(userId);
      const drive = await factories.createDrive(userId);
      driveId = drive.id;
      createdDrives.push(driveId);
    } catch (error) {
      requireDb('page-content-lock.integration.test.ts', error);
      throw error;
    }
  });

  beforeEach(async () => {
    vi.mocked(createPageVersion).mockClear();
    const page = await factories.createPage(driveId, { content: '<p>start</p>', title: 'Doc' });
    pageId = page.id;
  });

  afterAll(async () => {
    await db.delete(drives).where(inArray(drives.id, createdDrives));
    await db.delete(users).where(inArray(users.id, createdUsers));
  });

  it('a rename moves the row revision and not the content lock', async () => {
    await update({ title: 'Renamed' });

    expect(await read()).toMatchObject({ title: 'Renamed', revision: 1, contentRevision: 0 });
  });

  it('REPORTED BUG: saving after a rename succeeds, with nobody else involved', async () => {
    const opened = await read();

    await update({ title: 'Renamed' });
    const saved = await update({ content: '<p>typed after the rename</p>' }, opened.contentRevision);

    expect(saved).toMatchObject({ success: true, page: { revision: 2, contentRevision: 1 } });
    expect(await read()).toMatchObject({ content: '<p>typed after the rename</p>', title: 'Renamed' });
  });

  it('a save after someone else changed the text is refused, and nothing is written', async () => {
    const opened = await read();

    await update({ content: '<p>their text</p>' }, opened.contentRevision);
    const refused = await update({ content: '<p>my text</p>' }, opened.contentRevision);

    expect(refused).toMatchObject({
      success: false,
      status: 409,
      currentContentRevision: 1,
      expectedContentRevision: 0,
    });
    expect(await read()).toMatchObject({ content: '<p>their text</p>', contentRevision: 1 });
  });

  it('an AI or tool write through the mutation moves the lock too, so it is not silently overwritten', async () => {
    const opened = await read();

    await applyPageMutation({
      pageId,
      operation: 'update',
      updates: { content: '<p>agent text</p>' },
      expectedRevision: opened.revision,
      context: { userId, isAiGenerated: true },
    });
    const refused = await update({ content: '<p>my text</p>' }, opened.contentRevision);

    expect(refused).toMatchObject({ success: false, status: 409 });
  });

  it('a resend of what is stored succeeds against a stale lock and records no edit', async () => {
    const opened = await read();
    await update({ content: '<p>sent once</p>' }, opened.contentRevision);
    const before = await read();
    vi.mocked(createPageVersion).mockClear();

    const resent = await update({ content: '<p>sent once</p>' }, opened.contentRevision);

    expect(resent).toMatchObject({ success: true, page: { contentRevision: before.contentRevision } });
    expect(await read()).toEqual(before);
    expect(createPageVersion).not.toHaveBeenCalled();
  });

  it('of many saves racing on one lock with different text, exactly one lands', async () => {
    const opened = await read();

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) => update({ content: `<p>racer ${index}</p>` }, opened.contentRevision))
    );

    const landed = results.filter((result) => result.success);
    const refused = results.filter((result) => !result.success);
    expect(landed).toHaveLength(1);
    expect(refused.map((result) => !result.success && result.status)).toEqual(Array(5).fill(409));
    expect(await read()).toMatchObject({ contentRevision: 1, revision: 1 });
  });

  it('a rename and a save racing both land, and neither claims the same revision', async () => {
    // Without the row lock both read revision N and both write N+1: the row ends
    // one short, and the activity chain holds two entries for one position.
    for (let round = 0; round < 8; round += 1) {
      const before = await read();

      const [renamed, saved] = await Promise.all([
        update({ title: `Title ${round}` }),
        update({ content: `<p>round ${round}</p>` }, before.contentRevision),
      ]);

      expect(renamed).toMatchObject({ success: true });
      expect(saved).toMatchObject({ success: true });
      expect(await read()).toMatchObject({
        title: `Title ${round}`,
        content: `<p>round ${round}</p>`,
        revision: before.revision + 2,
        contentRevision: before.contentRevision + 1,
      });
    }
  });

  it.each(['cell', 'growing cell', 'append', 'delete', 'cell format', 'tab format', 'growing format'])(
    'serializes an editor save with a concurrent %s writer without a page/sheet deadlock',
    async (writer) => {
      const initial = serializeSheetContent({
        version: 1, rowCount: 2, columnCount: 2,
        cells: { A1: 'before', A2: 'second' },
      }, { pageId });
      await db.update(pages).set({ type: 'SHEET', content: initial }).where(eq(pages.id, pageId));
      await materializeFromDocument(pageId, initial);
      const incoming = serializeSheetContent({
        version: 1, rowCount: 2, columnCount: 2,
        cells: { A1: 'editor', A2: 'second' },
      }, { pageId });
      let concurrent: Promise<unknown> | undefined;
      try {
        await db.transaction(async (tx) => {
          await tx.select({ id: pages.id }).from(pages).where(eq(pages.id, pageId)).for('update');
          const holder = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
          const holderPid = Number(holder.rows[0].pid);
          concurrent = db.transaction(async (other) => {
            const ref = { pageId };
            const actor = { userId };
            switch (writer) {
              case 'cell': return setCells(ref, [{ address: 'B2', value: 'writer' }], actor, other);
              case 'growing cell': return setCells(ref, [{ address: 'C3', value: 'writer' }], actor, other);
              case 'append': return appendRows(ref, [{ A: 'writer' }], actor, other);
              case 'delete': return deleteRows(ref, 1, 1, actor, other);
              case 'cell format': return applyFormatOps(ref, [{ type: 'setCellFormat', range: 'B2', patch: { bold: true } }], actor, other);
              case 'tab format': return applyFormatOps(ref, [{ type: 'setColumnWidth', column: 'B', width: 240 }], actor, other);
              default: return applyFormatOps(ref, [{ type: 'setCellFormat', range: 'C3', patch: { bold: true } }], actor, other);
            }
          });
          // Attach immediately: a deadlock victim may reject before the holder.
          void concurrent.catch(() => {});
          const deadline = Date.now() + 3000;
          for (;;) {
            const waiting = await tx.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE ${holderPid} = ANY(pg_blocking_pids(pid))`);
            if (Number(waiting.rows[0].n) > 0) break;
            if (Date.now() > deadline) throw new Error('Sheet writer never waited on the held page');
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          // Original code reaches this with the sheet lock held by the writer,
          // producing the exact pages -> sheet -> pages cycle from the review.
          await applyPageMutation({
            pageId, operation: 'update', updates: { content: incoming },
            expectedContentRevision: 0, context: { userId }, tx,
          });
        });
        await concurrent;
        expect(await read()).toMatchObject({ revision: 2, contentRevision: 2 });
        const projected = parseSheetContent((await readSheetDocument(pageId))!);
        expect(projected.cells.A1).toBe('editor');
        if (writer === 'cell') expect(projected.cells.B2).toBe('writer');
        if (writer === 'growing cell') expect(projected.cells.C3).toBe('writer');
        if (writer === 'append') expect(projected.cells.A3).toBe('writer');
        if (writer === 'delete') expect(projected.cells.A2).toBeUndefined();
        if (writer === 'cell format') expect(projected.formats?.B2).toMatchObject({ bold: true });
        if (writer === 'growing format') expect(projected.formats?.C3).toMatchObject({ bold: true });
        if (writer === 'tab format') expect(projected.columnWidths?.B).toBe(240);
        const stale = await update({ content: incoming }, 1);
        expect(stale).toMatchObject({ success: false, status: 409, currentContentRevision: 2 });
      } finally {
        // Never leave a rejected or pending writer leaking into the next case.
        await concurrent?.catch(() => {});
      }
    }, 15000,
  );


});
