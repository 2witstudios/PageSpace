import { test, expect } from '../../fixtures/auth.fixture';
import { deleteUsers, hydrated, imagoPath, imagoUser, signIn } from '../../fixtures/imago.fixture';

/**
 * # Imago C v3 tokens in the browser (IMC-1.2)
 *
 * Frame widths are asserted on the laid-out columns by the shell specs (Tailwind emits a size
 * token only where a class uses it). The served stylesheet resolves the v3 tokens to the SPEC's values in light mode: what a
 * component paints with is what the boards specify, not only what the source file says.
 */
test.describe('imago-c tokens', () => {
  const created: string[] = [];
  test.afterAll(async () => deleteUsers(created));

  test('given light mode, should resolve the spine, tab bar, tint and page-type hues to SPEC', async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'theme', value: 'light', url: baseURL ?? 'http://127.0.0.1:3000' }]);
    const user = await imagoUser('Jono');
    created.push(user.id);
    await signIn(page, user, imagoPath(user.homeDriveId));
    await hydrated(page);
    const read = (names: string[]) =>
      page.evaluate((list) => {
        const probe = document.createElement('div');
        document.body.append(probe);
        const out: Record<string, string> = {};
        for (const name of list) {
          probe.style.color = `var(${name})`;
          out[name] = getComputedStyle(probe).color;
        }
        probe.remove();
        return out;
      }, names);
    const colours = await read(['--spine', '--tab-bar', '--tint', '--type-channel']);
    expect(colours).toEqual({
      '--spine': 'oklch(0.35 0.08 235)',
      '--tab-bar': 'oklch(0.975 0.006 235)',
      '--tint': 'oklch(0.982 0.005 235)',
      '--type-channel': 'oklch(0.55 0.14 300)',
    });
  });
});
