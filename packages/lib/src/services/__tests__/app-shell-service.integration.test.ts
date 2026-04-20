/**
 * Integration tests for `loadAppShell`.
 *
 * Requires a running Postgres database with the latest migrations applied.
 * Run via:
 *   ./scripts/test-with-db.sh
 *   pnpm --filter @pagespace/lib test -- src/services/__tests__/app-shell-service.integration.test.ts
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
import { loadAppShell } from '../app-shell-service';

describe('loadAppShell (integration)', () => {
  beforeEach(async () => {
    // FK-order delete to avoid cascade contention.
    await db.delete(channelMessages);
    await db.delete(chatMessages);
    await db.delete(connections);
    await db.delete(pagePermissions);
    await db.delete(pages);
    await db.delete(driveMembers);
    await db.delete(drives);
    await db.delete(users);
  });

  it('returns user identity, owned + member drives, drive members, and connections', async () => {
    const callerUser = await factories.createUser();
    const ownerUser = await factories.createUser();
    const peerUser = await factories.createUser();

    const ownDrive = await factories.createDrive(callerUser.id, { name: 'My Drive' });
    const sharedDrive = await factories.createDrive(ownerUser.id, { name: 'Shared Drive' });
    await factories.createDriveMember(sharedDrive.id, callerUser.id, { role: 'ADMIN' });

    await db.insert(connections).values({
      user1Id: callerUser.id,
      user2Id: peerUser.id,
      requestedBy: callerUser.id,
      status: 'ACCEPTED',
      acceptedAt: new Date(),
    });

    const shell = await loadAppShell(callerUser.id);

    expect(shell.user.id).toBe(callerUser.id);
    expect(shell.user.email).toBe(callerUser.email);

    const driveIds = shell.drives.map((d) => d.id).sort();
    expect(driveIds).toEqual([ownDrive.id, sharedDrive.id].sort());

    const ownEntry = shell.drives.find((d) => d.id === ownDrive.id)!;
    expect(ownEntry.isOwned).toBe(true);
    expect(ownEntry.role).toBe('OWNER');

    const sharedEntry = shell.drives.find((d) => d.id === sharedDrive.id)!;
    expect(sharedEntry.isOwned).toBe(false);
    expect(sharedEntry.role).toBe('ADMIN');

    expect(shell.driveMembers.some((m) => m.driveId === sharedDrive.id && m.userId === callerUser.id)).toBe(true);

    expect(shell.connections).toHaveLength(1);
    expect(shell.connections[0].peerUserId).toBe(peerUser.id);
    expect(shell.connections[0].initiatedByCaller).toBe(true);
    expect(shell.connections[0].status).toBe('ACCEPTED');

    expect(shell.activeDrive).toBeUndefined();
    expect(shell.currentPage).toBeUndefined();
    expect(typeof shell.generatedAt).toBe('string');
  });

  it('does not leak data from drives the caller has no access to', async () => {
    const callerUser = await factories.createUser();
    const otherUser = await factories.createUser();

    const callerDrive = await factories.createDrive(callerUser.id);
    const otherDrive = await factories.createDrive(otherUser.id);
    await factories.createPage(otherDrive.id);

    const shell = await loadAppShell(callerUser.id);

    expect(shell.drives.map((d) => d.id)).toEqual([callerDrive.id]);
    expect(shell.driveMembers.every((m) => m.driveId === callerDrive.id)).toBe(true);
  });

  it('includes the active drive page tree when activeDriveId is provided', async () => {
    const callerUser = await factories.createUser();
    const drive = await factories.createDrive(callerUser.id);
    const folder = await factories.createPage(drive.id, { type: 'FOLDER', position: 0 });
    const child = await factories.createPage(drive.id, {
      type: 'DOCUMENT',
      parentId: folder.id,
      position: 1,
    });
    // Trashed page should NOT appear in the tree.
    await factories.createPage(drive.id, { isTrashed: true, trashedAt: new Date() });

    const shell = await loadAppShell(callerUser.id, { activeDriveId: drive.id });

    expect(shell.activeDrive?.driveId).toBe(drive.id);
    const treeIds = shell.activeDrive?.tree.map((n) => n.id).sort() ?? [];
    expect(treeIds).toEqual([folder.id, child.id].sort());
  });

  it('omits activeDrive when the user has no access to the requested drive', async () => {
    const callerUser = await factories.createUser();
    const stranger = await factories.createUser();
    const otherDrive = await factories.createDrive(stranger.id);
    await factories.createPage(otherDrive.id);

    const shell = await loadAppShell(callerUser.id, { activeDriveId: otherDrive.id });

    expect(shell.activeDrive).toBeUndefined();
  });

  it('includes the current page payload when currentPageId is provided', async () => {
    const callerUser = await factories.createUser();
    const drive = await factories.createDrive(callerUser.id);
    const page = await factories.createPage(drive.id, { type: 'DOCUMENT', title: 'Hello' });

    const shell = await loadAppShell(callerUser.id, { currentPageId: page.id });

    expect(shell.currentPage?.page.id).toBe(page.id);
    expect(shell.currentPage?.page.title).toBe('Hello');
    expect(shell.currentPage?.breadcrumb.length).toBeGreaterThan(0);
    expect(shell.currentPage?.breadcrumb[shell.currentPage.breadcrumb.length - 1].id).toBe(page.id);
  });

  it('throws when the caller user does not exist', async () => {
    await expect(loadAppShell('does-not-exist')).rejects.toThrow(/user not found/);
  });
});
