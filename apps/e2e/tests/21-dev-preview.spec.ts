import { test, expect, type APIRequestContext, type Browser, type BrowserContext } from '@playwright/test';
import {
  CONSENT_COOKIE_NAME,
  defaultConsentState,
  rejectNonEssential,
  serializeConsentState,
} from '@pagespace/lib/consent';
import { seedUser, type SeededUser } from '../support/db';
import { sessionGet, sessionPost } from '../support/http';

/**
 * # Dev-server preview, end to end through a REAL browser and a REAL sandbox
 *
 * This is the one check no unit test can stand in for, and the reason it
 * exists: every layer of the preview — detection, the relay, the grant
 * handshake, the partitioned cookie, the iframe, the HMR socket — is
 * individually tested and none of that proves a browser can load the app.
 * The journey is: sign in → open a session → start a dev server inside its
 * sandbox → see the affordance appear on its own → click Preview → watch the
 * app render through `https://ws-<id>.preview.<apex>/` → edit a file → watch
 * HMR update the frame without a reload.
 *
 * ## It does not run by default, and that is not laziness
 *
 * It needs three things a normal CI run does not have, and it names them
 * rather than failing obscurely:
 *
 *  - a real Sprite sandbox (`E2E_SANDBOX=1`, a tier that may run code, and
 *    the platform credentials);
 *  - the preview feature configured (`DEV_PREVIEW_ENABLED` + a
 *    `DEV_PREVIEW_APEX` with wildcard DNS and a wildcard certificate) — the
 *    spec probes `/api/dev-preview/capability` and skips when it is dark;
 *  - `apps/realtime` reachable, because detection IS the realtime tier's
 *    `ports/watch` channel and the HMR half of the proxy is its upgrade
 *    handler. Without it nothing is ever detected and every assertion here
 *    fails for a reason that is not about the preview.
 *
 * ## The `allowedHosts` case is deliberately covered
 *
 * The preview reaches the dev server through PageSpace's hostname, and Vite 6+
 * rejects a `Host` it does not know. That is the single most likely thing a
 * real user hits, so this spec starts a server WITHOUT the allow-list first
 * and records what the user actually sees, then starts one with it and
 * asserts the app renders. The first half is documentation as much as
 * assertion: if it ever starts passing, the platform changed and the
 * changelog's warning should go.
 *
 * ## Typing into a terminal
 *
 * There is no HTTP route that runs a command in a sandbox — deliberately, the
 * PTY lives on the realtime socket. So the spec drives the real terminal, and
 * addresses it by xterm's own `.xterm-helper-textarea` (a library class, not
 * a PageSpace detail) rather than a test id the product does not owe it.
 */

const SESSION_TTL_MS = 60 * 60 * 1000;
/** A dev server, an npm install and a sandbox cold start — minutes, not seconds. */
const SANDBOX_TIMEOUT_MS = 5 * 60 * 1000;
/** How long to wait for detection to surface a port after the server binds. */
const DETECTION_TIMEOUT_MS = 60 * 1000;

const sandboxEnabled = () => process.env.E2E_SANDBOX === '1' && Boolean(process.env.DATABASE_URL);

async function previewConfigured(request: APIRequestContext): Promise<boolean> {
  // The one unauthenticated probe that answers "is this deployment dark?".
  const response = await request.get('/api/dev-preview/capability');
  if (!response.ok()) return false;
  return ((await response.json()) as { enabled?: boolean }).enabled === true;
}

async function previewContext(browser: Browser, sessionToken: string, baseURL: string): Promise<BrowserContext> {
  const url = new URL(baseURL);
  // `bypassCSP` for the same harness reason spec 17 documents: locally the
  // realtime server is on another port, which the app's own `connect-src`
  // correctly refuses. A real deployment reaches realtime same-origin.
  const context = await browser.newContext({ baseURL, bypassCSP: true });
  const decided = rejectNonEssential(defaultConsentState(), new Date(0).toISOString());
  await context.addCookies([
    {
      name: 'session',
      value: sessionToken,
      domain: url.hostname,
      path: '/',
      httpOnly: true,
      secure: url.protocol === 'https:',
      sameSite: 'Strict',
      expires: Math.floor((Date.now() + SESSION_TTL_MS) / 1000),
    },
    {
      name: CONSENT_COOKIE_NAME,
      value: encodeURIComponent(serializeConsentState(decided)),
      domain: url.hostname,
      path: '/',
      httpOnly: false,
      secure: url.protocol === 'https:',
      sameSite: 'Lax',
    },
  ]);
  return context;
}

interface SessionWithSandbox {
  workspaceId: string;
  shellId: string;
}

/**
 * `firstThing: 'shell'` is the one route that provisions a sandbox AND opens a
 * PTY in a single call — exactly what this spec needs and nothing more.
 */
async function createSessionWithSandbox(request: APIRequestContext, user: SeededUser): Promise<SessionWithSandbox> {
  const response = await sessionPost(request, '/api/agent-workspaces', user, {
    driveId: user.driveId,
    firstThing: 'shell',
    name: 'dev-preview smoke',
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as { session: { workspaceId: string }; shellId: string };
  return { workspaceId: body.session.workspaceId, shellId: body.shellId };
}

async function writeSandboxFile(request: APIRequestContext, user: SeededUser, workspaceId: string, path: string, content: string) {
  const response = await sessionPost(request, `/api/agent-workspaces/${workspaceId}/files`, user, {
    path,
    kind: 'file',
    content,
    encoding: 'utf8',
    overwrite: true,
  });
  expect(response.ok(), `writing ${path}: ${await response.text()}`).toBe(true);
}

interface PreviewStatus {
  // The state NAMES the port — there is no separate pending-port field, so a
  // needs-approval status and the port awaiting a decision cannot disagree.
  state: { status: string; targetPort?: number; message: string };
  canOpen: boolean;
  canApprove: boolean;
  openPath: string | null;
}

async function readPreview(request: APIRequestContext, user: SeededUser, workspaceId: string): Promise<PreviewStatus> {
  const response = await sessionGet(request, `/api/agent-workspaces/${workspaceId}/preview`, user);
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { preview: PreviewStatus }).preview;
}

/** Poll the status route until `predicate` holds, or fail naming the last state seen. */
async function waitForPreview(
  request: APIRequestContext,
  user: SeededUser,
  workspaceId: string,
  predicate: (preview: PreviewStatus) => boolean,
  timeoutMs = DETECTION_TIMEOUT_MS,
): Promise<PreviewStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: PreviewStatus | null = null;
  while (Date.now() < deadline) {
    last = await readPreview(request, user, workspaceId);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`preview never reached the expected state; last seen: ${JSON.stringify(last)}`);
}

/** Type a command into the session's real terminal and press Enter. */
async function runInShell(context: BrowserContext, user: SeededUser, workspaceId: string, command: string) {
  const page = await context.newPage();
  await page.goto(`/dashboard/${user.driveId}/agents?workspace=${workspaceId}`);
  const terminal = page.locator('.xterm-helper-textarea').first();
  await terminal.waitFor({ state: 'attached', timeout: SANDBOX_TIMEOUT_MS });
  await terminal.focus();
  await page.keyboard.type(`${command}\n`);
  return page;
}

const VITE_CONFIG_WITHOUT_HOSTS = `import { defineConfig } from 'vite';\nexport default defineConfig({ server: { host: '0.0.0.0', port: 5173 } });\n`;
const VITE_CONFIG_WITH_HOSTS = `import { defineConfig } from 'vite';\nexport default defineConfig({ server: { host: '0.0.0.0', port: 5173, allowedHosts: true } });\n`;
const INDEX_HTML = `<!doctype html><html><body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>\n`;
const MAIN_JS = (marker: string) => `document.getElementById('app').textContent = ${JSON.stringify(marker)};\n`;
const PACKAGE_JSON = `{ "name": "preview-smoke", "private": true, "type": "module", "scripts": { "dev": "vite" }, "devDependencies": { "vite": "^6.0.0" } }\n`;

test.describe('dev-server preview: the browser journey', () => {
  test.skip(
    !sandboxEnabled(),
    'Set E2E_SANDBOX=1 (with DATABASE_URL, sandbox credentials and a code-execution-eligible tier) to run the dev-preview smoke.',
  );

  const contexts: BrowserContext[] = [];
  test.afterEach(async () => {
    await Promise.all(contexts.map((context) => context.close()));
    contexts.length = 0;
  });

  test('a Vite dev server on a usual port is detected, previewed, and hot-reloads inside the frame', async ({ request, browser, baseURL }) => {
    test.skip(!(await previewConfigured(request)), 'The preview feature is dark on this deployment (DEV_PREVIEW_ENABLED / DEV_PREVIEW_APEX).');
    test.setTimeout(SANDBOX_TIMEOUT_MS * 3);

    const user = await seedUser({ tier: 'pro' });
    const { workspaceId } = await createSessionWithSandbox(request, user);
    const context = await previewContext(browser, user.sessionToken, baseURL ?? 'http://localhost:3000');
    contexts.push(context);

    await writeSandboxFile(request, user, workspaceId, 'preview-smoke/package.json', PACKAGE_JSON);
    await writeSandboxFile(request, user, workspaceId, 'preview-smoke/index.html', INDEX_HTML);
    await writeSandboxFile(request, user, workspaceId, 'preview-smoke/src/main.js', MAIN_JS('first render'));

    // ---- the Host-header failure, recorded rather than assumed ---------------
    // Vite 6+ refuses a Host it does not know, and the preview arrives on
    // PageSpace's hostname. This half exists so we know exactly what the user
    // sees when they have not set `allowedHosts`.
    await writeSandboxFile(request, user, workspaceId, 'preview-smoke/vite.config.js', VITE_CONFIG_WITHOUT_HOSTS);
    await runInShell(context, user, workspaceId, 'cd preview-smoke && npm install && npm run dev');

    const detected = await waitForPreview(request, user, workspaceId, (preview) => preview.state.targetPort === 5173, SANDBOX_TIMEOUT_MS);
    expect(detected.state.targetPort).toBe(5173);
    // 5173 is a known dev-server port, so it is relayed with no approval.
    expect(detected.canApprove).toBe(false);

    const page = await context.newPage();
    await page.goto(`/dashboard/${user.driveId}/agents?workspace=${workspaceId}`);
    await page.getByTestId('dev-preview-affordance').waitFor({ timeout: DETECTION_TIMEOUT_MS });
    await page.getByRole('button', { name: 'Preview' }).click();
    const frame = page.frameLocator('[data-testid="dev-preview-frame"]');

    // Without `allowedHosts` the dev server answers the proxy with its own
    // refusal, so the app does NOT render.
    //
    // A bare `not.toHaveText` would be VACUOUS here: it passes the instant the
    // element is absent, which is also what an empty frame looks like. So wait
    // for the frame to actually have rendered SOMETHING first, then assert
    // that something is not the app. If this ever fails because the marker
    // appeared, Vite or the platform changed and the changelog warning can go.
    const blocked = frame.locator('body');
    await expect(blocked).not.toBeEmpty({ timeout: 30_000 });
    await expect(blocked).not.toContainText('first render');

    // ---- with the allow-list: the app renders, and HMR works ----------------
    await writeSandboxFile(request, user, workspaceId, 'preview-smoke/vite.config.js', VITE_CONFIG_WITH_HOSTS);
    await runInShell(context, user, workspaceId, 'cd preview-smoke && npm run dev');
    await page.getByTitle('Reload the preview').click();
    await expect(frame.locator('#app')).toHaveText('first render', { timeout: SANDBOX_TIMEOUT_MS });

    // HMR: edit the module and assert the FRAME updates without a reload. The
    // navigation counter is what makes "without a reload" an assertion rather
    // than a hope.
    const framePage = page.frameLocator('[data-testid="dev-preview-frame"]');
    await writeSandboxFile(request, user, workspaceId, 'preview-smoke/src/main.js', MAIN_JS('hot updated'));
    await expect(framePage.locator('#app')).toHaveText('hot updated', { timeout: 60_000 });

    // Open in a new tab mints its OWN grant (the partitioned cookie does not
    // travel to a top-level navigation), so the app must render there too.
    const status = await readPreview(request, user, workspaceId);
    expect(status.openPath).not.toBeNull();
    const tab = await context.newPage();
    await tab.goto(status.openPath as string);
    await expect(tab.locator('#app')).toHaveText('hot updated', { timeout: 60_000 });
  });

  test('an UNLISTED port is detected but serves nothing until it is explicitly shared', async ({ request, browser, baseURL }) => {
    test.skip(!(await previewConfigured(request)), 'The preview feature is dark on this deployment (DEV_PREVIEW_ENABLED / DEV_PREVIEW_APEX).');
    test.setTimeout(SANDBOX_TIMEOUT_MS * 2);

    const user = await seedUser({ tier: 'pro' });
    const { workspaceId } = await createSessionWithSandbox(request, user);
    const context = await previewContext(browser, user.sessionToken, baseURL ?? 'http://localhost:3000');
    contexts.push(context);

    // A plain node server on 9000 — no framework, no install, nothing to go
    // wrong except the thing under test.
    await writeSandboxFile(
      request,
      user,
      workspaceId,
      'unlisted/server.js',
      `import { createServer } from 'node:http';\ncreateServer((_req, res) => { res.end('unlisted app'); }).listen(9000, '0.0.0.0');\n`,
    );
    await runInShell(context, user, workspaceId, 'cd unlisted && node server.js');

    const pending = await waitForPreview(request, user, workspaceId, (preview) => preview.state.status === 'needs-approval', SANDBOX_TIMEOUT_MS);
    expect(pending.state.targetPort).toBe(9000);
    expect(pending.canApprove).toBe(true);
    expect(pending.canOpen).toBe(false);

    // The proxy refuses it — detection is not exposure.
    const refused = await request.get(pending.openPath as string, { headers: { cookie: `session=${user.sessionToken}` } });
    expect(refused.ok()).toBe(false);

    // A port the row does not target cannot be approved by a click meant for it.
    const wrongPort = await sessionPost(request, `/api/agent-workspaces/${workspaceId}/preview/actions`, user, { action: 'approve', port: 9001 });
    expect(wrongPort.status()).toBe(409);

    const approved = await sessionPost(request, `/api/agent-workspaces/${workspaceId}/preview/actions`, user, { action: 'approve', port: 9000 });
    expect(approved.ok(), await approved.text()).toBe(true);

    await waitForPreview(request, user, workspaceId, (preview) => preview.canOpen, DETECTION_TIMEOUT_MS);
    const page = await context.newPage();
    await page.goto(`/dashboard/${user.driveId}/agents?workspace=${workspaceId}`);
    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.frameLocator('[data-testid="dev-preview-frame"]').locator('body')).toContainText('unlisted app', { timeout: 60_000 });
  });

  test('signing out cuts the preview on its very next request, not when the cookie expires', async ({ request, browser, baseURL }) => {
    test.skip(!(await previewConfigured(request)), 'The preview feature is dark on this deployment (DEV_PREVIEW_ENABLED / DEV_PREVIEW_APEX).');
    test.setTimeout(SANDBOX_TIMEOUT_MS * 2);

    const user = await seedUser({ tier: 'pro' });
    const { workspaceId } = await createSessionWithSandbox(request, user);
    const context = await previewContext(browser, user.sessionToken, baseURL ?? 'http://localhost:3000');
    contexts.push(context);

    await writeSandboxFile(
      request,
      user,
      workspaceId,
      'known/server.js',
      `import { createServer } from 'node:http';\ncreateServer((_req, res) => { res.end('still here'); }).listen(5173, '0.0.0.0');\n`,
    );
    await runInShell(context, user, workspaceId, 'cd known && node server.js');
    const live = await waitForPreview(request, user, workspaceId, (preview) => preview.canOpen, SANDBOX_TIMEOUT_MS);

    const page = await context.newPage();
    await page.goto(`/dashboard/${user.driveId}/agents?workspace=${workspaceId}`);
    await page.getByRole('button', { name: 'Preview' }).click();
    const frame = page.frameLocator('[data-testid="dev-preview-frame"]');
    await expect(frame.locator('body')).toContainText('still here', { timeout: 60_000 });

    // Sign out through the app's own logout route: the preview cookie names this
    // session, and the per-request gather re-checks it on every request.
    const signOut = await sessionPost(request, '/api/auth/logout', user, {});
    expect(signOut.ok(), await signOut.text()).toBe(true);

    await page.getByTitle('Reload the preview').click();
    // Same anti-vacuity rule as the allowedHosts case: wait for the frame to
    // have rendered SOMETHING (the refusal, or the sign-in the re-mint lands
    // on) before asserting it is no longer the app. The exact copy is not
    // asserted — a revoked session and a signed-out app origin produce
    // different pages, and both are correct answers to "this is over".
    const after = frame.locator('body');
    await expect(after).not.toBeEmpty({ timeout: 30_000 });
    await expect(after).not.toContainText('still here');
    expect(live.openPath).not.toBeNull();
  });
});
