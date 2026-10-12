/**
 * Renders the Imago C v3 design boards to the half-scale reference PNGs the imago-c specs attach
 * (IMC-1.1, DEC-C3). The boards are the owner's design artifact
 * (https://claude.ai/artifact/LJrpGeksFZwZG7jzXQQcX7): export its `project/` folder and
 * `artifact-type/dc-runtime.js`, then run
 *
 *   node scripts/render-imago-boards.mjs <exported project dir> <dc-runtime.js> [Board …]
 *
 * Each board is served with the runtime as its `support.js`, rendered at its 1440×900 preview
 * size and written to imago-boards/<Board>.png at device scale 0.5. A state of a board is
 * rendered by naming it `Board@state=label1>label2`: each label is clicked (by accessible name)
 * on the board before the shot, which is how the board's own renderVals reach that state.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const [projectDir, runtime, ...only] = process.argv.slice(2);
if (!projectDir || !runtime) {
  console.error('usage: node scripts/render-imago-boards.mjs <project dir> <dc-runtime.js> [Board[@state=a>b] …]');
  process.exit(2);
}
const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'imago-boards');
const boards = only.length
  ? only
  : fs.readdirSync(projectDir).filter((f) => /^C-.*\.dc\.html$/.test(f)).map((f) => f.replace('.dc.html', ''));

const server = http
  .createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0]).slice(1);
    const file = name === 'support.js' ? runtime : path.join(projectDir, path.basename(name));
    if (!fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(0);
const { port } = server.address();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 0.5 });
for (const spec of boards) {
  const [board, state] = spec.split('@');
  await page.goto(`http://127.0.0.1:${port}/${board}.dc.html`);
  await page.waitForLoadState('networkidle');
  for (const label of (state?.split('=')[1] ?? '').split('>').filter(Boolean)) {
    await page.getByRole('button', { name: label, exact: true }).first().click();
  }
  await page.waitForTimeout(300);
  const out = path.join(outDir, `${state ? `${board}@${state.split('=')[0]}` : board}.png`);
  await page.screenshot({ path: out });
  console.log('rendered', path.basename(out));
}
await browser.close();
server.close();
