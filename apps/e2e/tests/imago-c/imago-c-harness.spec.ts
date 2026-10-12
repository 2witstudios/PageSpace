import { test, expect } from '../../fixtures/auth.fixture';
import { deleteUsers, hydrated, imagoPath, imagoUser, signIn } from '../../fixtures/imago.fixture';
import { attachBoard, seedCanon } from '../../fixtures/imago-c.fixture';
import { CANON_TREE } from '../../support/imago-c/canon';

/**
 * # Imago C v3 harness (IMC-1.1)
 *
 * Proves the pieces every imago-c spec stands on: the CANON seed reaches the real app through
 * its real API (the Files tree lists the canon top level), and a board reference attaches
 * beside the live screenshot. Runs in the CI e2e topology (see 27-imago-shell.spec.ts).
 */
test.describe('imago-c harness', () => {
  const created: string[] = [];
  test.afterAll(async () => deleteUsers(created));

  test('given the CANON seed, should show the Studio tree and attach the C-Files-Index board', async ({ page }, testInfo) => {
    const user = await imagoUser('Jono');
    created.push(user.id);
    const canon = await seedCanon(user.id);
    await signIn(page, user, imagoPath(canon.driveId, 'files'));
    await hydrated(page);
    const pane = page.locator('[data-slot="list"]');
    for (const node of CANON_TREE) {
      await expect(pane.getByRole('link', { name: node.title, exact: true }).first()).toBeVisible();
    }
    await attachBoard(testInfo, page, 'C-Files-Index');
    expect(testInfo.attachments.map((a) => a.name)).toEqual(['C-Files-Index · board', 'C-Files-Index · app']);
  });
});
