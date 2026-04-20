/**
 * Integration tests for `loadPagePayload`.
 *
 * Requires a running Postgres database with the latest migrations applied.
 * Run via:
 *   ./scripts/test-with-db.sh
 *   pnpm --filter @pagespace/lib test -- src/services/__tests__/page-payload-service.integration.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { factories } from '@pagespace/db/test/factories';
import {
  db,
  users,
  drives,
  pages,
  pagePermissions,
  driveMembers,
  channelMessages,
  chatMessages,
  connections,
} from '@pagespace/db';
import { loadPagePayload } from '../page-payload-service';
import { PageType } from '../../utils/enums';

describe('loadPagePayload (integration)', () => {
  beforeEach(async () => {
    await db.delete(channelMessages);
    await db.delete(chatMessages);
    await db.delete(connections);
    await db.delete(pagePermissions);
    await db.delete(pages);
    await db.delete(driveMembers);
    await db.delete(drives);
    await db.delete(users);
  });

  it('returns the page row, breadcrumb, and empty context for a plain document', async () => {
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const folder = await factories.createPage(drive.id, { type: 'FOLDER', title: 'Folder', position: 0 });
    const doc = await factories.createPage(drive.id, {
      type: 'DOCUMENT',
      title: 'Doc',
      parentId: folder.id,
      position: 1,
    });

    const payload = await loadPagePayload(owner.id, doc.id);

    expect(payload.page.id).toBe(doc.id);
    expect(payload.page.title).toBe('Doc');
    expect(payload.breadcrumb.map((b) => b.id)).toEqual([folder.id, doc.id]);
    expect(payload.breadcrumb[0].title).toBe('Folder');
    expect(payload.context.document?.contentMode).toBe('html');
  });

  it('includes recent channel messages for CHANNEL pages, ordered oldest-first', async () => {
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const channel = await factories.createPage(drive.id, { type: 'CHANNEL', title: 'general' });

    const earlier = new Date('2026-01-01T00:00:00Z');
    const later = new Date('2026-01-02T00:00:00Z');
    await db.insert(channelMessages).values([
      { content: 'first', pageId: channel.id, userId: owner.id, createdAt: earlier },
      { content: 'second', pageId: channel.id, userId: owner.id, createdAt: later },
    ]);

    const payload = await loadPagePayload(owner.id, channel.id);

    expect(payload.context.channelMessages?.map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('includes recent chat messages for AI_CHAT pages and skips inactive ones', async () => {
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const chat = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'AI' });

    await factories.createChatMessage(chat.id, { content: 'kept', isActive: true });
    await factories.createChatMessage(chat.id, { content: 'dropped', isActive: false });

    const payload = await loadPagePayload(owner.id, chat.id);

    expect(payload.context.chatMessages?.map((m) => m.content)).toEqual(['kept']);
    expect(payload.context.chatMessages?.[0].role).toBeDefined();
  });

  it('returns FILE context with metadata for FILE pages', async () => {
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const file = await factories.createPage(drive.id, {
      type: 'FILE',
      title: 'cat.png',
      fileSize: 1234,
      mimeType: 'image/png',
      originalFileName: 'cat.png',
    });

    const payload = await loadPagePayload(owner.id, file.id);

    expect(payload.context.file?.fileSize).toBe(1234);
    expect(payload.context.file?.mimeType).toBe('image/png');
    expect(payload.context.file?.originalFileName).toBe('cat.png');
  });

  it('throws when the user is not authorized to view the page', async () => {
    const owner = await factories.createUser();
    const stranger = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const page = await factories.createPage(drive.id);

    await expect(loadPagePayload(stranger.id, page.id)).rejects.toThrow(/not accessible/);
  });

  it('respects expired explicit grants (denies access)', async () => {
    const owner = await factories.createUser();
    const grantee = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const page = await factories.createPage(drive.id);
    await factories.createPagePermission(page.id, grantee.id, {
      canView: true,
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(loadPagePayload(grantee.id, page.id)).rejects.toThrow(/not accessible/);
  });

  it('grants access to a user with a future-expiring view grant', async () => {
    const owner = await factories.createUser();
    const grantee = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const page = await factories.createPage(drive.id, { title: 'Granted Doc' });
    await factories.createPagePermission(page.id, grantee.id, {
      canView: true,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const payload = await loadPagePayload(grantee.id, page.id);
    expect(payload.page.id).toBe(page.id);
    expect(payload.page.type).toBe(PageType.DOCUMENT);
  });
});
