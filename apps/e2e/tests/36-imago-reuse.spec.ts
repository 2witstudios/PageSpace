import { openTaskConfiguration, selectTaskFilter, openTaskActions } from '../fixtures/retained-tasks.fixture';
import { browserGet } from '../fixtures/browser-api.fixture';
import { DEFAULT_AI_PROVIDER, DEFAULT_AI_MODEL } from '@pagespace/lib/ai/model-defaults';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { sessions } from '@pagespace/db/schema/sessions';
import { conversations } from '@pagespace/db/schema/conversations';
import { and } from '@pagespace/db/operators';
import { imagoUser, freshBrowser, signIn, hydrated, deleteUsers, imagoPath, type ImagoUser } from '../fixtures/imago.fixture';

let user: ImagoUser;
const extraUsers: string[] = [];
const contexts: BrowserContext[] = [];
const mockOrigin = process.env.E2E_MOCK_OPENROUTER_URL ?? `http://127.0.0.1:${process.env.E2E_MOCK_OPENROUTER_PORT ?? 4998}`;
test.beforeEach(async ({ request }) => { await request.post(`${mockOrigin}/__reset`); user = await imagoUser('Reuse test user', { currentAiProvider: DEFAULT_AI_PROVIDER, currentAiModel: DEFAULT_AI_MODEL }); });
test.afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.close())); if (user) await deleteUsers([user.id, ...extraUsers.splice(0)]); });
async function open(browser: Parameters<typeof freshBrowser>[0], baseURL: string, path: string) {
  const { context, page } = await freshBrowser(browser, baseURL);
  contexts.push(context);
  page.on('response', async response => { if (response.status() >= 400) { console.log('HTTP failure:', response.status(), new URL(response.url()).pathname); if (new URL(response.url()).pathname === '/api/ai/chat') { const body = await response.json().catch(() => ({})) as { error?: string; code?: string }; console.log('Chat refusal:', body.error, body.code); } } });
  page.on('pageerror', error => console.log('Browser error:', error.message.replace(/nonce-[^' ]+/g, 'nonce-REDACTED')));
  page.on('console', message => { if (message.type() === 'error') console.log('Browser console:', message.text().replace(/nonce-[^' ]+/g, 'nonce-REDACTED').replace(/https?:\/\/[^\s'"]+/g, value => { try { const url = new URL(value); return url.origin + url.pathname; } catch { return '[URL]'; } })); });
  await signIn(page, user, path);
  await hydrated(page);
  return page;
}
async function shot(page: Page, name: string) {
  await page.screenshot({ path: `../../docs/imago/evidence/${name}.png`, fullPage: true });
}

test('creates through the retained palette, edits with the retained toolbar and persists a document', async ({ browser, baseURL }) => {
  const page = await open(browser, baseURL!, imagoPath(user.homeDriveId, 'files'));
  await page.getByRole('button', { name: 'New page', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create new page' });
  await expect(dialog).toBeVisible();
  for (const type of ['Document', 'Code', 'Sheet', 'Canvas', 'Channel', 'Task List', 'AI Chat']) {
    await expect(dialog.getByRole('option').filter({ hasText: type }).first()).toBeVisible();
  }
  await dialog.getByRole('option').filter({ hasText: 'Document' }).first().click();
  const name = page.getByPlaceholder('Untitled Document');
  await name.fill('Reuse proof');
  const creation = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/pages');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const answer = await creation;
  expect(answer.ok()).toBe(true);
  const created = await answer.json() as { id: string };
  await expect(page).toHaveURL(new RegExp(`/files/${created.id}$`));
  const editor = page.locator('.retained-ui .tiptap[contenteditable="true"]').first();
  await expect(editor).toBeVisible();
  const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/pages/${created.id}`);
  await editor.click();
  await page.keyboard.type('Persisted through the retained editor.');
  expect((await saved).ok()).toBe(true);
  await expect.poll(async () => (await db.select({ content: pages.content }).from(pages).where(eq(pages.id, created.id)))[0]?.content).toContain('Persisted through the retained editor.');
  await shot(page, 'document-light');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByLabel('Account menu', { exact: true }).click();
  await page.getByRole('radio', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.retained-ui.dark').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.locator('.tiptap').first().evaluate(node => getComputedStyle(node).color)).toMatch(/okl(?:ab|ch)\(0\.97 /);
  await shot(page, 'document-dark');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Page history' })).toBeVisible();
  await expect(page.getByText('Page Activity', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('.retained-ui .tiptap').first()).toContainText('Persisted through the retained editor.');
});

test('resolves an object by its actual drive, retaining one shell and one chat', async ({ browser, baseURL }) => {
  const other = await factories.createDrive(user.id, { name: 'Other drive' });
  const crossDrivePage = await factories.createPage(other.id, { type: 'DOCUMENT', title: 'Cross-drive object', content: '<p>Resolved in its own drive.</p>' });
  const page = await open(browser, baseURL!, imagoPath(user.homeDriveId, 'files'));
  await expect(page.getByRole('region', { name: 'Chat', exact: true }).locator('textarea')).toBeEditable();
  const pointerBody = JSON.parse((await browserGet(page, '/api/user/builtin-agents')).body) as { agents: { key: string; title: string; pageId: string | null }[] };
  const agentId = pointerBody.agents.find(agent => agent.title === 'Imago')?.pageId;
  expect(agentId).toBeTruthy();
  const conversationId = (await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.userId, user.id), eq(conversations.contextId, agentId!))))[0]?.id;
  expect(conversationId).toBeTruthy();
  await factories.createChatMessage(agentId!, { conversationId, role: 'assistant', content: `Open @[Cross-drive object](${crossDrivePage.id}:page).` });
  await page.reload();
  await hydrated(page);
  await page.evaluate(() => { document.documentElement.dataset.shellProof = 'kept'; });
  await page.getByRole('region', { name: 'Chat', exact: true }).getByRole('link', { name: '@Cross-drive object', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/imago/${other.id}/files/${crossDrivePage.id}$`));
  await expect(page.locator('.retained-ui .tiptap').first()).toContainText('Resolved in its own drive.');
  await expect(page.locator('section[aria-label="Chat"]')).toHaveCount(1);
  await expect(page.locator('[data-section]')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.dataset.shellProof)).toBe('kept');
  await shot(page, 'cross-drive');
});

test('settings and typed object views stay in Imago', async ({ browser, baseURL }) => {
  const page = await open(browser, baseURL!, imagoPath(user.homeDriveId, 'files'));
  const views = [
    ['CODE', 'example.ts', 'const ported = true;', '.monaco-editor'],
    ['SHEET', 'Numbers', '', '[role="grid"]'],
    ['CANVAS', 'Canvas proof', '<h1>Canvas proof</h1>', 'iframe'],
    ['TASK_LIST', 'Tasks proof', '', 'text=Tasks proof'],
    ['CHANNEL', 'Channel proof', '', '[role=log]'],
  ] as const;
  for (const [type, title, content, selector] of views) {
    const object = await factories.createPage(user.homeDriveId, { type, title, content });
    await page.goto(imagoPath(user.homeDriveId, `files/${object.id}`));
    await hydrated(page);
    await expect(page.locator(selector).first()).toBeVisible();
    await expect(page.getByText('Open in classic', { exact: true })).toHaveCount(0);
    await shot(page, type.toLowerCase());
  }
  await page.goto('/imago/account');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  for (const title of ['Drives', 'Storage', 'Connections', 'Agents', 'AI Providers', 'Personalization']) {
    await expect(page.getByRole('link').filter({ hasText: title }).first()).toBeVisible();
  }
  if (process.env.NEXT_PUBLIC_DEPLOYMENT_MODE === 'tenant' || process.env.NEXT_PUBLIC_DEPLOYMENT_MODE === 'onprem') {
    await expect(page.getByRole('link').filter({ hasText: /^Billing/ })).toHaveCount(0);
  }
  await shot(page, 'settings-light');
});

test('read-only members cannot edit document or canvas, including while permissions are loading', async ({ browser, baseURL }) => {
  const reader = await imagoUser('Read-only member'); extraUsers.push(reader.id);
  await factories.createDriveMember(user.homeDriveId, reader.id, { role: 'MEMBER' });
  const doc = await factories.createPage(user.homeDriveId, { type: 'DOCUMENT', title: 'Read-only document', content: '<p>Protected content.</p>' });
  const canvas = await factories.createPage(user.homeDriveId, { type: 'CANVAS', title: 'Read-only canvas', content: '<h1>Protected canvas</h1>' });
  await factories.createPagePermission(doc.id, reader.id);
  await factories.createPagePermission(canvas.id, reader.id);
  const { context, page } = await freshBrowser(browser, baseURL!); contexts.push(context);
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/pages/${doc.id}/permissions/check*`, async route => { await held; await route.continue(); });
  const writes: string[] = [];
  page.on('request', request => { if (request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/pages/${doc.id}`) writes.push(request.url()); });
  await signIn(page, reader, imagoPath(user.homeDriveId, `files/${doc.id}`));
  await expect(page.locator('.retained-ui .tiptap').first()).toBeVisible();
  await expect(page.locator('.retained-ui .tiptap').first()).toHaveAttribute('contenteditable', 'false');
  release!();
  await expect(page.getByText("You don't have permission to edit this document", { exact: true })).toBeVisible();
  await page.locator('.retained-ui .tiptap').first().click(); await page.keyboard.type('Attempted mutation');
  expect(writes).toEqual([]);
  await shot(page, 'read-only');
  await page.goto(imagoPath(user.homeDriveId, `files/${canvas.id}`));
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeDisabled();
  await expect(page.locator('iframe').first()).toBeVisible();
});

test('a revoked session refuses a retained editor write and returns to public sign-in', async ({ browser, baseURL }) => {
  const doc = await factories.createPage(user.homeDriveId, { type: 'DOCUMENT', title: 'Session boundary', content: '<p>Protected before revocation.</p>' });
  const path = imagoPath(user.homeDriveId, `files/${doc.id}`);
  const page = await open(browser, baseURL!, path);
  const editor = page.locator('.retained-ui .tiptap').first();
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await expect(page.getByRole('region', { name: 'Chat', exact: true }).locator('textarea')).toBeEditable();
  let releaseWrite: () => void = () => {};
  let noteWrite: () => void = () => {};
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  const writeSeen = new Promise<void>(resolve => { noteWrite = resolve; });
  await page.route(url => url.pathname === `/api/pages/${doc.id}`, async route => {
    if (route.request().method() === 'PATCH') {
      noteWrite();
      await writeGate;
    }
    await route.continue();
  });
  try {
    const refused = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/pages/${doc.id}` && response.status() === 401);
    await editor.click();
    await page.keyboard.type(' Refused after revocation.');
    await writeSeen;
    // Invalidate this fixture user's sessions/devices before the real write reaches
    // the server. No fabricated response or auth-expired event is used.
    await db.update(users).set({ tokenVersion: sql`${users.tokenVersion} + 1` }).where(eq(users.id, user.id));
    await db.update(sessions).set({ revokedAt: new Date(), revokedReason: 'e2e-revocation' }).where(eq(sessions.userId, user.id));
    releaseWrite();
    expect((await refused).status()).toBe(401);
    await page.waitForURL(url => url.pathname === '/auth/signin');
    expect(new URL(page.url()).searchParams.get('next')).toBe(path);
    expect((await db.select({ content: pages.content }).from(pages).where(eq(pages.id, doc.id)))[0]?.content).not.toContain('Refused after revocation.');
  } finally {
    releaseWrite();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('retained channel controls send, edit, quote and reply through the existing APIs', async ({ browser, baseURL }) => {
  const channel = await factories.createPage(user.homeDriveId, { type: 'CHANNEL', title: 'Interaction channel' });
  const page = await open(browser, baseURL!, imagoPath(user.homeDriveId, `files/${channel.id}`));
  const object = page.locator('[data-slot="object"]');
  const composer = object.getByRole('combobox');
  await expect(composer).toBeEditable();
  const sent = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/channels/${channel.id}/messages`);
  await composer.fill('Original retained message');
  await composer.press('Enter');
  const response = await sent;
  expect(response.ok()).toBe(true);
  await expect(object.getByText('Original retained message', { exact: true })).toBeVisible();
  await object.getByText('Original retained message', { exact: true }).hover();
  await object.getByRole('button', { name: 'Message options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  const edit = object.getByRole('textbox');
  await edit.fill('Edited retained message');
  const patched = page.waitForResponse(answer => answer.request().method() === 'PATCH' && new URL(answer.url()).pathname.startsWith(`/api/channels/${channel.id}/messages/`));
  await object.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await patched).ok()).toBe(true);
  await expect(object.getByText('Edited retained message', { exact: true })).toBeVisible();
  await object.getByText('Edited retained message', { exact: true }).hover();
  await object.getByRole('button', { name: 'Quote reply', exact: true }).click();
  await composer.fill('Quoted retained response');
  await composer.press('Enter');
  await expect(object.getByText('Quoted retained response', { exact: true })).toBeVisible();
  await object.getByText('Edited retained message', { exact: true }).first().hover();
  await object.getByRole('button', { name: 'Reply in thread', exact: true }).first().click();
  const thread = page.getByRole('complementary', { name: 'Thread', exact: true });
  await expect(thread).toBeVisible();
  await thread.getByRole('combobox').fill('A persisted threaded reply');
  await thread.getByRole('combobox').press('Enter');
  await expect(thread.getByText('A persisted threaded reply', { exact: true })).toBeVisible();
  await thread.getByRole('button', { name: 'Close thread', exact: true }).click();
  await object.getByText('Edited retained message', { exact: true }).first().hover();
  await object.getByRole('button', { name: 'Add reaction', exact: true }).first().click();
  await page.getByRole('button', { name: '👍', exact: true }).first().click();
  await expect(object.getByRole('button', { name: /👍/ }).first()).toBeVisible();
  await shot(page, 'channel-interactions');
  await page.reload();
  await expect(object.getByText('Edited retained message', { exact: true }).first()).toBeVisible();
  await expect(object.getByText('Quoted retained response', { exact: true })).toBeVisible();
});

test('one rich chat input sends and keeps its unsent draft through native object navigation', async ({ browser, baseURL }) => {
  const doc = await factories.createPage(user.homeDriveId, { type: 'DOCUMENT', title: 'Chat context proof', content: '<p>Context stays native.</p>' });
  const page = await open(browser, baseURL!, imagoPath(user.homeDriveId, 'files'));
  const chat = page.getByRole('region', { name: 'Chat', exact: true });
  const composer = chat.locator('textarea');
  await expect(composer).toBeEditable();
  await composer.fill('Hello from the retained chat input');
  await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(chat.getByText('pong', { exact: true })).toBeVisible({ timeout: 30_000 });
  await composer.fill('An unsent persistent draft');
  await page.evaluate(() => { document.documentElement.dataset.shellProof = 'kept'; });
  await page.locator('[data-slot="list"]').getByText('Chat context proof', { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/files/${doc.id}$`));
  await expect(composer).toHaveValue('An unsent persistent draft');
  expect(await page.evaluate(() => document.documentElement.dataset.shellProof)).toBe('kept');
  await expect(chat).toHaveCount(1);
  await expect(chat.locator('textarea')).toHaveCount(1);
  await shot(page, 'chat-persistent');
});

test('code, sheet and canvas edits persist through their original editors', async ({ browser, baseURL }) => {
  const code = await factories.createPage(user.homeDriveId, { type: 'CODE', title: 'saved.ts', content: 'const before = true;' });
  const sheet = await factories.createPage(user.homeDriveId, { type: 'SHEET', title: 'Saved numbers' });
  const canvas = await factories.createPage(user.homeDriveId, { type: 'CANVAS', title: 'Saved canvas', content: '<h1>Before</h1>' });
  const page = await open(browser, baseURL!, imagoPath(user.homeDriveId, `files/${code.id}`));
  const input = page.locator('[data-slot="object"] .monaco-editor textarea');
  await expect(input).toBeEditable();
  await input.focus(); await page.keyboard.press('Control+A'); await page.keyboard.type('const after = 42;');
  await expect.poll(async () => (await db.select({ content: pages.content }).from(pages).where(eq(pages.id, code.id)))[0]?.content).toBe('const after = 42;');
  await page.goto(imagoPath(user.homeDriveId, `files/${sheet.id}`));
  const formula = page.getByRole('textbox', { name: 'Cell value or formula' });
  await expect(formula).toBeEditable();
  await formula.fill('123'); await formula.press('Enter'); await formula.blur();
  await expect.poll(async () => (JSON.parse((await browserGet(page, `/api/pages/${sheet.id}`)).body) as { content: string }).content, { timeout: 15_000 }).toContain('123');
  await page.reload(); await expect(page.getByRole('grid').first()).toContainText('123');
  await page.goto(imagoPath(user.homeDriveId, `files/${canvas.id}`));
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await expect(input).toBeEditable();
  await expect(page.locator('[data-slot="object"] .view-lines')).toContainText('<h1>Before</h1>');
  await input.focus(); await page.keyboard.press('Control+A'); await page.keyboard.type('After canvas edit');
  await expect.poll(async () => (await db.select({ content: pages.content }).from(pages).where(eq(pages.id, canvas.id)))[0]?.content).toBe('After canvas edit');
  await page.getByRole('button', { name: 'View', exact: true }).click();
  const preview = await browserGet(page, `/api/canvas/${canvas.id}/preview`);
  expect(preview.body).toContain('After canvas edit');
  expect(preview.coep).toBe('credentialless');
  await expect(page.locator('[data-slot="object"] iframe')).toHaveCount(1);
  await expect(page.frameLocator('[data-slot="object"] iframe').getByText('After canvas edit', { exact: true })).toBeVisible();
  await shot(page, 'canvas-saved');
});

test('uploads a file through the retained palette and opens its specialized viewer', async ({ browser, baseURL }) => {
  const page = await open(browser, baseURL!, imagoPath(user.homeDriveId, 'files'));
  await page.getByRole('button', { name: 'New page', exact: true }).click();
  await page.getByRole('dialog', { name: 'Create new page' }).getByRole('option').filter({ hasText: 'File' }).first().click();
  await page.locator('#retained-portals input[type="file"]').setInputFiles({ name: 'reuse-proof.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64') });
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page).toHaveURL(/\/files\/[^/]+$/, { timeout: 30_000 });
  await expect(page.locator('[data-slot="object"] img').first()).toBeVisible();
  await expect(page.getByText('Open in classic', { exact: true })).toHaveCount(0);
  await shot(page, 'file-upload');
});

test('agent sessions and drive configuration remain native and preserve one chat', async ({ browser, baseURL }) => {
  const page = await open(browser, baseURL!, imagoPath(user.homeDriveId, 'agents'));
  await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Chat', exact: true })).toHaveCount(1);
  await expect(page.getByRole('complementary', { name: 'Agent sessions', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New Session', exact: true }).click();
  const palette = page.getByRole('dialog');
  await palette.getByRole('option').filter({ hasText: 'Imago' }).first().click();
  const name = palette.getByPlaceholder('Imago', { exact: true });
  await name.fill('Native agent session');
  const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/agent-workspaces');
  await name.press('Enter');
  expect((await created).ok()).toBe(true);
  await expect(page.getByRole('complementary', { name: 'Agent sessions', exact: true })).toContainText('Native agent session');
  await expect(page.getByRole('region', { name: 'Chat', exact: true }).locator('textarea')).toBeEditable();
  await expect(page.getByRole('region', { name: 'Chat', exact: true }).locator('textarea')).toHaveCount(1);
  await shot(page, 'agents');
  await page.goto(imagoPath(user.homeDriveId, 'settings/integrations'));
  await expect(page.getByText('No integrations connected to this drive.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
  await shot(page, 'drive-integrations');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('dialog', { name: 'Connect Integration', exact: true }).getByRole('button', { name: /^GitHub/ }).click();
  const connection = page.getByRole('dialog', { name: 'Connect GitHub', exact: true });
  await expect(connection.getByLabel('Connection Name', { exact: true })).toBeEditable();
  await expect(connection.getByRole('button', { name: 'Authorize', exact: true })).toBeEnabled();
  await shot(page, 'drive-integration-configuration');
  await connection.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(connection).toHaveCount(0);
});

test('sheet permissions also stay read-only while loading and after a view-only grant', async ({ browser, baseURL }) => {
  const reader = await imagoUser('Sheet reader'); extraUsers.push(reader.id);
  await factories.createDriveMember(user.homeDriveId, reader.id, { role: 'MEMBER' });
  const sheet = await factories.createPage(user.homeDriveId, { type: 'SHEET', title: 'Protected sheet' });
  await factories.createPagePermission(sheet.id, reader.id);
  const { context, page } = await freshBrowser(browser, baseURL!); contexts.push(context);
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/pages/${sheet.id}/permissions/check*`, async route => { await held; await route.continue(); });
  await signIn(page, reader, imagoPath(user.homeDriveId, `files/${sheet.id}`));
  const formula = page.getByRole('textbox', { name: 'Cell value or formula' });
  await expect(formula).toBeDisabled();
  release!();
  await expect(page.getByText("You don't have permission to edit this sheet", { exact: true })).toBeVisible();
  await expect(formula).toBeDisabled();
});

test('chat attachments survive navigation and persist as rendered file parts', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const doc = await factories.createPage(user.homeDriveId, { type: 'DOCUMENT', title: 'Attachment context', content: '<p>Native attachment context.</p>' });
  const page = await open(browser, baseURL!, imagoPath(user.homeDriveId, 'files'));
  const chat = page.getByRole('region', { name: 'Chat', exact: true });
  const composer = chat.locator('textarea');
  await expect(composer).toBeEditable();
  await expect(chat.getByRole('button', { name: 'Attach images', exact: true })).toBeEnabled();
  await chat.locator('input[type="file"]').first().setInputFiles({ name: 'chat-proof.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64') });
  await expect(chat.getByRole('button', { name: 'Remove chat-proof.png' })).toBeVisible();
  await page.locator('[data-slot="list"]').getByText('Attachment context', { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/files/${doc.id}$`));
  await expect(chat.getByRole('button', { name: 'Remove chat-proof.png' })).toBeVisible();
  const request = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/ai/chat');
  await composer.fill('Inspect the attached image');
  await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  const body = (await request).postDataJSON() as { messages: { role: string; parts: { type: string; mediaType?: string }[] }[] };
  expect(body.messages[body.messages.length - 1]?.parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'file', mediaType: 'image/png' })]));
  // The real upload and message pipeline stores/renders the file part. The local
  // storage IP is intentionally refused by the model SDK's SSRF guard; no bypass.
  await expect(chat.getByRole('button', { name: 'chat-proof.png', exact: true })).toBeVisible();
  await expect(chat.getByRole('button', { name: 'Remove chat-proof.png' })).toHaveCount(0);
  const stop = chat.getByRole('button', { name: 'Stop generating', exact: true });
  if (await stop.isVisible()) await stop.click();
  await expect(stop).toHaveCount(0);
  await shot(page, 'chat-attachment-parts');
});

test('queued text dispatches after the current live stream finishes', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const page = await open(browser, baseURL!, imagoPath(user.homeDriveId, 'files'));
  const chat = page.getByRole('region', { name: 'Chat', exact: true });
  const composer = chat.locator('textarea');
  await expect(composer).toBeEditable();
  const mock = mockOrigin;
  await page.request.post(`${mock}/__reset`);
  await page.request.post(`${mock}/__stream-config`, { data: { mode: 'held' } });
  await composer.fill('Hold this reply');
  await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(`${mock}/__streams`)).json() as { held: number }).held).toBe(1);
  await composer.fill('Queued through the retained input');
  await chat.getByRole('button', { name: 'Queue message', exact: true }).click();
  await expect(composer).toHaveValue('');
  await expect(chat.getByRole('list', { name: 'Queued messages' })).toContainText('Queued through the retained input');
  await page.request.post(`${mock}/__stream-config`, { data: { mode: 'instant' } });
  await page.request.post(`${mock}/__release-stream`);
  await expect.poll(async () => (await (await page.request.get(`${mock}/__calls`)).json() as { count: number }).count, { timeout: 30_000 }).toBe(2);
  await expect(chat.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
  await shot(page, 'chat-attachments-queue');
});

test('task creation and completion persist through retained task controls', async ({ browser, baseURL }) => {
  const list = await factories.createPage(user.homeDriveId, { type: 'TASK_LIST', title: 'Interactive tasks' });
  const page = await open(browser, baseURL!, imagoPath(user.homeDriveId, `files/${list.id}`));
  const object = page.locator('[data-slot="object"]');
  await object.getByRole('button', { name: 'New Task', exact: true }).click();
  const input = object.locator('input[placeholder="+ Add a new task..."]:visible');
  await expect(input).toBeFocused();
  const creation = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/pages/${list.id}/tasks`);
  await input.fill('Complete retained task'); await input.press('Enter');
  expect((await creation).status()).toBe(201);
  await expect(object.getByText('Complete retained task', { exact: true }).filter({ visible: true })).toBeVisible();
  const patch = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname.startsWith(`/api/pages/${list.id}/tasks/`));
  await object.getByRole('checkbox', { name: 'Complete Complete retained task', exact: true }).filter({ visible: true }).click();
  expect((await patch).ok()).toBe(true);
  await page.reload();
  await selectTaskFilter(page, 'Completed');
  await expect(object.getByRole('checkbox', { name: 'Reopen Complete retained task', exact: true }).filter({ visible: true })).toBeChecked();
  await shot(page, 'task-interactions');
});

test('task agent triggers save, survive reload and remove through retained controls', async ({ browser, baseURL }) => {
  const list = await factories.createPage(user.homeDriveId, { type: 'TASK_LIST', title: 'Trigger tasks' });
  const agent = await factories.createPage(user.homeDriveId, { type: 'AI_CHAT', title: 'Trigger proof agent' });
  const page = await open(browser, baseURL!, imagoPath(user.homeDriveId, `tasks/${list.id}`));
  const object = page.locator('[data-slot="object"]');
  await object.getByRole('button', { name: 'New Task', exact: true }).click();
  const input = object.locator('input[placeholder="+ Add a new task..."]:visible');
  const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/pages/${list.id}/tasks`);
  await input.fill('Task with a trigger');
  await input.press('Enter');
  const creation = await created;
  expect(creation.status()).toBe(201);
  await input.press('Escape');
  const task = await creation.json() as { id: string };
  await expect(object.locator(`[data-task-id="${task.id}"]:visible`)).toBeVisible();
  const triggersPath = `/api/tasks/${task.id}/triggers`;
  const openTriggers = async () => {
    const actions = await openTaskActions(page, task.id, 'Task with a trigger');
    await actions.getByRole('button', { name: 'Agent triggers', exact: true })
      .or(actions.getByRole('menuitem', { name: 'Agent triggers…', exact: true })).click();
  };
  await openTriggers();
  const dialog = page.getByRole('dialog', { name: 'Agent triggers', exact: true });
  const completion = dialog.getByRole('switch', { name: 'Run when task is completed', exact: true });
  await expect(completion).toBeEnabled();
  await expect(dialog.getByRole('switch', { name: 'Run when due date arrives', exact: true })).toBeDisabled();
  await completion.click();
  await dialog.getByRole('combobox').click();
  await page.getByRole('option', { name: 'Trigger proof agent', exact: true }).click();
  const prompt = dialog.getByPlaceholder('What should the agent do when the task is completed?');
  await prompt.fill('Summarize the completed task.');
  const saved = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === triggersPath);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(dialog.getByRole('button', { name: 'Update', exact: true })).toBeVisible();
  const stored = JSON.parse((await browserGet(page, triggersPath)).body) as { triggers: { agentPageId: string; triggerType: string; prompt: string; isEnabled: boolean }[] };
  expect(stored.triggers).toEqual([expect.objectContaining({ agentPageId: agent.id, triggerType: 'completion', prompt: 'Summarize the completed task.', isEnabled: true })]);
  await page.reload();
  await openTriggers();
  await expect(completion).toBeChecked();
  await expect(prompt).toHaveValue('Summarize the completed task.');
  await expect(dialog.getByRole('combobox')).toHaveText('Trigger proof agent');
  await shot(page, 'task-agent-trigger');
  const removed = page.waitForResponse(response => response.request().method() === 'DELETE' && new URL(response.url()).pathname === `${triggersPath}/completion`);
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  expect((await removed).ok()).toBe(true);
  await expect(completion).not.toBeChecked();
  expect(JSON.parse((await browserGet(page, triggersPath)).body)).toMatchObject({ triggers: [] });

  const reader = await imagoUser('Trigger read-only member'); extraUsers.push(reader.id);
  await factories.createDriveMember(user.homeDriveId, reader.id, { role: 'MEMBER' });
  await factories.createPagePermission(list.id, reader.id);
  const viewer = await freshBrowser(browser, baseURL!); contexts.push(viewer.context);
  let releasePermission: () => void = () => {};
  let notePermission: () => void = () => {};
  const permissionGate = new Promise<void>(resolve => { releasePermission = resolve; });
  const permissionSeen = new Promise<void>(resolve => { notePermission = resolve; });
  const permissionPath = `/api/pages/${list.id}/permissions/check`;
  await viewer.page.route(url => url.pathname === permissionPath, async route => {
    notePermission();
    await permissionGate;
    await route.continue();
  });
  try {
    await signIn(viewer.page, reader, imagoPath(user.homeDriveId, `tasks/${list.id}`));
    await hydrated(viewer.page);
    const readOnlyActions = await openTaskActions(viewer.page, task.id, 'Task with a trigger');
    await permissionSeen;
    const assertReadOnly = async () => {
      if (await readOnlyActions.getAttribute('role') === 'menu') {
        await expect(readOnlyActions.getByRole('menuitem', { name: 'Agent triggers…', exact: true })).toBeDisabled();
      } else {
        await expect(readOnlyActions.getByRole('button', { name: 'Agent triggers', exact: true })).toHaveCount(0);
        await expect(readOnlyActions.getByRole('checkbox', { name: 'Complete Task with a trigger', exact: true })).toBeDisabled();
        await expect(readOnlyActions.getByRole('button', { name: 'Delete task', exact: true })).toBeDisabled();
      }
    };
    await assertReadOnly();
    const checked = viewer.page.waitForResponse(response => new URL(response.url()).pathname === permissionPath);
    releasePermission();
    expect((await checked).ok()).toBe(true);
    await assertReadOnly();
    const refusedRead = await viewer.page.evaluate(async path => (await fetch(path, { credentials: 'same-origin' })).status, triggersPath);
    expect(refusedRead).toBe(403);
  } finally {
    releasePermission();
    await viewer.page.unrouteAll({ behavior: 'wait' });
  }
});

test('direct messaging creates a destination and sends through native conversation controls', async ({ browser, baseURL }) => {
  const recipient = await imagoUser('Reuse recipient'); extraUsers.push(recipient.id);
  await factories.createDriveMember(user.homeDriveId, recipient.id, { role: 'MEMBER' });
  const page = await open(browser, baseURL!, '/imago/dm/new');
  const object = page.locator('[data-slot="object"]');
  await object.getByPlaceholder('Search connections and drive members...').fill('Reuse recipient');
  await object.getByText('Reuse recipient', { exact: true }).click();
  await object.getByRole('button', { name: 'Start Conversation', exact: true }).click();
  await expect(page).toHaveURL(/\/imago\/dm\/[^/]+$/);
  const input = object.getByRole('combobox');
  await expect(input).toBeEditable();
  const sent = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.includes('/api/messages/'));
  await input.fill('A direct message from Imago'); await input.press('Enter');
  expect((await sent).ok()).toBe(true);
  await expect(input).toHaveValue('');
  await expect(object.locator('p').filter({ hasText: 'A direct message from Imago' })).toBeVisible();
  await page.reload();
  await expect(object.locator('p').filter({ hasText: 'A direct message from Imago' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Chat', exact: true })).toHaveCount(1);
  await shot(page, 'dm-interactions');
});

test('sharing controls grant a real view permission and preserve the reader boundary', async ({ browser, baseURL }) => {
  const reader = await imagoUser('Shared document reader'); extraUsers.push(reader.id);
  const sharedDrive = await factories.createDrive(user.id, { name: 'Shareable workspace' });
  await factories.createDriveMember(sharedDrive.id, reader.id, { role: 'MEMBER' });
  const doc = await factories.createPage(sharedDrive.id, { type: 'DOCUMENT', title: 'UI shared document', content: '<p>Shared through native controls.</p>', isPrivate: true });
  const page = await open(browser, baseURL!, imagoPath(sharedDrive.id, `files/${doc.id}`));
  await page.locator('[data-slot="object"]').getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const sharedPath = imagoPath(sharedDrive.id, `files/${doc.id}`);
  await expect(dialog.getByLabel('Page link', { exact: true })).toHaveValue(`${new URL(baseURL!).origin}${sharedPath}`);
  const row = await db.query.users.findFirst({ where: eq(users.id, reader.id), columns: { email: true } });
  await dialog.getByPlaceholder('Add people by email...').fill(row!.email);
  const grant = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/pages/${doc.id}/permissions`);
  await dialog.getByRole('button', { name: 'Grant Access', exact: true }).click();
  expect((await grant).ok()).toBe(true);
  await shot(page, 'sharing');
  const fresh = await freshBrowser(browser, baseURL!); contexts.push(fresh.context);
  await signIn(fresh.page, reader, new URL(await dialog.getByLabel('Page link', { exact: true }).inputValue()).pathname);
  const editor = fresh.page.locator('.retained-ui .tiptap').first();
  await expect(editor).toContainText('Shared through native controls.');
  await expect(editor).toHaveAttribute('contenteditable', 'false');
});

test('interactive questions render and resume through the existing authorized chat pipeline', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const page = await open(browser, baseURL!, imagoPath(user.homeDriveId, 'files'));
  const chat = page.getByRole('region', { name: 'Chat', exact: true });
  const composer = chat.locator('textarea');
  await expect(composer).toBeEditable();
  const mock = mockOrigin;
  await page.request.post(`${mock}/__next-tool`, { data: { name: 'ask_user', arguments: { questions: [{ header: 'Choice', question: 'Which response should the test choose?', options: [{ label: 'First response' }, { label: 'Second response' }] }] } } });
  await composer.fill('Ask an interactive question');
  await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(chat.getByText('Which response should the test choose?', { exact: true })).toBeVisible({ timeout: 30_000 });
  await chat.getByRole('button', { name: /First response/ }).click();
  const resumed = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/ai/chat');
  await chat.getByRole('button', { name: 'Submit', exact: true }).click();
  expect((await resumed).ok()).toBe(true);
  await expect(chat.getByText('pong', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(chat.getByText('First response', { exact: true }).first()).toBeVisible();
  await shot(page, 'chat-question');
  await page.reload();
  await expect(chat.getByText('pong', { exact: true })).toBeVisible();
});

test('persisted approval cards use the session API and retain a real service refusal', async ({ browser, baseURL }) => {
  const page = await open(browser, baseURL!, imagoPath(user.homeDriveId, 'files'));
  const chat = page.getByRole('region', { name: 'Chat', exact: true });
  await expect(chat.locator('textarea')).toBeEditable();
  const roster = JSON.parse((await browserGet(page, '/api/user/builtin-agents')).body) as { agents: { title: string; pageId: string | null }[] };
  const agentId = roster.agents.find(agent => agent.title === 'Imago')?.pageId;
  expect(agentId).toBeTruthy();
  const conversationId = (await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.userId, user.id), eq(conversations.contextId, agentId!))))[0]?.id;
  expect(conversationId).toBeTruthy();
  // A canonical persisted result exercises reconstruction and the rich consumer.
  // The isolated runtime has no credential plane, so its real API must refuse.
  const accountId = 'approval-fixture-account';
  const requestDigest = 'a'.repeat(64);
  const toolCallId = 'approval-fixture-call';
  await factories.createChatMessage(agentId!, {
    conversationId, role: 'assistant',
    content: JSON.stringify({ textParts: [], partsOrder: [{ index: 0, type: 'tool-http_request', toolCallId }], originalContent: '' }),
    toolCalls: JSON.stringify([{ toolCallId, toolName: 'http_request', input: { method: 'POST', url: 'https://example.com/fixture' }, state: 'output-available' }]),
    toolResults: JSON.stringify([{ toolCallId, toolName: 'http_request', state: 'output-available', output: { error: 'approval_required', approval: { accountId, requestDigest, stepUp: false, subject: { headline: 'Canonical fixture approval', origin: 'https://example.com', path: '/fixture' } } } }]),
  });
  await page.reload(); await hydrated(page);
  await chat.getByRole('button', { name: /Http Request/i }).click();
  await expect(chat.getByText('Canonical fixture approval', { exact: true })).toBeVisible();
  const refusal = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agent-accounts/approvals' && response.request().method() === 'POST');
  await chat.getByRole('button', { name: 'Approve once', exact: true }).click();
  const response = await refusal;
  expect(response.request().postDataJSON()).toEqual({ accountId, requestDigest });
  expect(response.status()).toBe(503);
  expect(await response.json()).toEqual({ error: 'not_configured' });
  await expect(chat.getByText('Could not record the approval.', { exact: true })).toBeVisible();
  await expect(chat.getByRole('button', { name: 'Approve once', exact: true })).toBeEnabled();
  await shot(page, 'chat-approval-refusal');
});


test('task statuses and anchored workflows persist through retained configuration dialogs', async ({ browser, baseURL }) => {
  const list = await factories.createPage(user.homeDriveId, { type: 'TASK_LIST', title: 'Configured tasks' });
  await factories.createPage(user.homeDriveId, { type: 'AI_CHAT', title: 'Workflow proof agent' });
  const page = await open(browser, baseURL!, imagoPath(user.homeDriveId, `tasks/${list.id}`));
  await openTaskConfiguration(page, 'Statuses');
  const statuses = page.getByRole('dialog', { name: 'Manage Status Categories', exact: true });
  await statuses.getByRole('button', { name: 'Add Status', exact: true }).click();
  await statuses.getByPlaceholder('Status name...').fill('Review ready');
  const statusSaved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/pages/${list.id}/tasks/statuses`);
  await statuses.getByRole('button', { name: 'Add Status', exact: true }).click();
  expect((await statusSaved).ok()).toBe(true);
  await expect(statuses.getByText('Review ready', { exact: true })).toBeVisible();
  await page.reload();
  await openTaskConfiguration(page, 'Statuses');
  await expect(page.getByRole('dialog', { name: 'Manage Status Categories', exact: true }).getByText('Review ready', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await openTaskConfiguration(page, 'Workflows');
  await page.getByRole('dialog', { name: 'Scheduled workflows', exact: true }).getByRole('button', { name: 'New workflow', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Create Workflow', exact: true });
  await form.getByLabel('Name', { exact: true }).fill('Retained workflow proof');
  await form.getByRole('button', { name: 'Add step', exact: true }).click();
  await page.getByRole('menuitem', { name: 'AI step', exact: true }).click();
  await form.getByRole('combobox').filter({ hasText: 'Use workflow default' }).click();
  await page.getByRole('option', { name: 'Workflow proof agent', exact: true }).click();
  await form.getByPlaceholder('Write a daily summary report...').fill('Summarize the configured task list.');
  await form.getByLabel('Enabled', { exact: true }).click();
  await expect(form.getByLabel('Enabled', { exact: true })).toHaveAttribute('aria-checked', 'false');
  const workflowSaved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/workflows');
  await form.getByRole('button', { name: 'Create', exact: true }).click();
  expect((await workflowSaved).status()).toBe(201);
  await expect(page.getByRole('dialog', { name: 'Scheduled workflows', exact: true }).getByText('Retained workflow proof', { exact: true })).toBeVisible();
  await page.reload();
  await openTaskConfiguration(page, 'Workflows');
  await expect(page.getByRole('dialog', { name: 'Scheduled workflows', exact: true }).getByText('Retained workflow proof', { exact: true })).toBeVisible();
  const workflows = page.getByRole('dialog', { name: 'Scheduled workflows', exact: true });
  await expect.poll(async () => {
    const bounds = await workflows.boundingBox();
    const action = await workflows.getByRole('button', { name: 'New workflow', exact: true }).boundingBox();
    return !!bounds && !!action && action.x >= bounds.x && action.x + action.width <= bounds.x + bounds.width;
  }, { message: 'workflow actions should fit inside their dialog' }).toBe(true);
  await shot(page, 'task-workflow-configuration');
});
