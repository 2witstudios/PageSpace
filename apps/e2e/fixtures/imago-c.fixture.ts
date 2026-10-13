import { readFile } from 'node:fs/promises';
import type { Page, TestInfo } from '@playwright/test';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { favorites } from '@pagespace/db/schema/core';
import { userPageViews } from '@pagespace/db/schema/page-views';
import { boardReference } from '../support/imago-c/board-reference';
import {
  CANON_FAVORITES,
  CANON_RECENTS,
  CANON_TREE,
  type CanonNode,
} from '../support/imago-c/canon';

/**
 * Imago C v3 fixtures (IMC-1.1, DEC-C3). Every imago-c spec seeds the CANON story into a
 * drive named "Studio", drives the real app through a board's states, asserts the geometry and
 * copy the board fixes, and attaches the app's screenshot beside the board's reference PNG.
 * Pixels are not compared: the app renders real API data, the board renders CANON.
 */

export type Canon = {
  readonly driveId: string;
  /** Page id by canon title. */
  readonly pages: Readonly<Record<string, string>>;
};

const contentFor = (node: CanonNode): string => (node.type === 'DOCUMENT' ? '<p></p>' : '');

/**
 * The CANON drive for `ownerId`: "Studio" with the canon tree in board order, the owner's two
 * favorites and the three recents viewed now, 1h and 2h ago.
 */
export const seedCanon = async (ownerId: string, now: Date = new Date()): Promise<Canon> => {
  const drive = await factories.createDrive(ownerId, { name: 'Studio', slug: `studio-${ownerId.slice(0, 8)}` });
  const pages: Record<string, string> = {};
  const create = async (nodes: readonly CanonNode[], parentId: string | null): Promise<void> => {
    for (const [index, node] of nodes.entries()) {
      const page = await factories.createPage(drive.id, {
        title: node.title,
        type: node.type,
        content: contentFor(node),
        parentId,
        position: index + 1,
      });
      pages[node.title] = page.id;
      await create(node.children ?? [], page.id);
    }
  };
  await create(CANON_TREE, null);
  await db.insert(favorites).values(
    CANON_FAVORITES.map((title, position) => ({ userId: ownerId, itemType: 'page' as const, pageId: pages[title], position })),
  );
  await db.insert(userPageViews).values(
    CANON_RECENTS.map(({ title, minutesAgo }) => ({
      userId: ownerId,
      pageId: pages[title],
      viewedAt: new Date(now.getTime() - minutesAgo * 60_000),
    })),
  );
  return { driveId: drive.id, pages };
};

/**
 * Attaches the board's reference PNG and the live page's screenshot to the report, side by side
 * under one name, so a reviewer compares the state against its board.
 */
export const attachBoard = async (
  testInfo: TestInfo,
  page: Page,
  board: string,
  state?: string,
): Promise<void> => {
  const name = state === undefined ? board : `${board}@${state}`;
  await testInfo.attach(`${name} · board`, { body: await readFile(boardReference(board, state)), contentType: 'image/png' });
  await testInfo.attach(`${name} · app`, { body: await page.screenshot(), contentType: 'image/png' });
};
