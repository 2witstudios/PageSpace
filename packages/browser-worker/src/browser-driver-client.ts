/**
 * The browser driver — the ONLY code that talks to Chromium, and the only
 * CDP client it has (S3 §3.1). Adapter only: it performs typed operations
 * and returns data; every decision about whether to perform them, and
 * whether their results may leave the worker, is made by the pure modules
 * the worker (`browser-control-worker.ts`) calls first.
 *
 * What it guarantees by construction:
 *  - CDP over a PIPE. Playwright launches Chromium with
 *    `--remote-debugging-pipe`; no debugging port exists for anything on the
 *    host to connect to. The integration suite asserts the process holds no
 *    listening TCP socket.
 *  - One throwaway profile per context: `profileDir` is created by the
 *    worker (mode 0700) and removed by `close`. A restart is a new directory.
 *  - Every connection through the worker's egress proxy, loopback included
 *    (`<-loopback>`), with QUIC off and WebRTC limited to proxied UDP (none),
 *    so nothing leaves the browser around the proxy.
 *  - No downloads, service workers blocked, dialogs dismissed.
 *  - Elements are reached by snapshot ref (`aria-ref=`), never a selector
 *    the caller writes, and nothing is evaluated in the page. The package's
 *    lint config refuses the Playwright methods that would do either.
 */
import { rm } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import type { BrowserControlResponse, BrowserOperation, BrowserOperationResult, PageSummary } from './browser-operation.js';
import type { HumanInput } from './control-instruction.js';

export type BrowserDriverOptions = {
  readonly profileDir: string;
  readonly proxyUrl: string;
  readonly executablePath?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
};

export type BrowserFrame = {
  readonly image: { readonly mediaType: 'image/jpeg'; readonly base64: string };
  readonly page: PageSummary | null;
};

export type BrowserDriver = {
  readonly run: (operation: BrowserOperation) => Promise<BrowserControlResponse>;
  readonly frame: () => Promise<BrowserFrame>;
  readonly humanInput: (input: HumanInput) => Promise<void>;
  readonly close: () => Promise<void>;
};

/** Accessibility snapshots are bounded before they leave (S3 §8, G4 read-side bound). */
export const MAX_SNAPSHOT_CHARS = 40_000;
const ACTION_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const SCREENSHOT_QUALITY = 60;

const CHROMIUM_ARGS: readonly string[] = [
  '--disable-quic',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-sync',
  '--no-first-run',
  '--password-store=basic',
];

const refused = (reason: 'element-not-found' | 'tab-not-found' | 'navigation-denied' | 'operation-failed', detail: string): BrowserControlResponse => ({
  ok: false,
  refusal: { reason, detail },
});

const errorText = (error: unknown): string => (error instanceof Error ? error.message.split('\n')[0] : String(error));

export const createBrowserDriver = async ({
  profileDir,
  proxyUrl,
  executablePath,
  viewport = { width: 1280, height: 800 },
}: BrowserDriverOptions): Promise<BrowserDriver> => {
  const context: BrowserContext = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    executablePath,
    proxy: { server: proxyUrl, bypass: '<-loopback>' },
    acceptDownloads: false,
    serviceWorkers: 'block',
    viewport,
    args: [...CHROMIUM_ARGS],
  });

  const tabIds = new WeakMap<Page, string>();
  let nextTab = 1;
  let active: Page | null = null;

  const track = (page: Page): void => {
    tabIds.set(page, `tab-${nextTab}`);
    nextTab += 1;
    active = page;
    page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));
    page.on('close', () => {
      if (active === page) active = context.pages().find((other) => other !== page) ?? null;
    });
  };
  context.pages().forEach(track);
  context.on('page', track);

  const activePage = async (): Promise<Page> => active ?? (await context.newPage());

  const summarize = async (page: Page): Promise<PageSummary> => ({
    tabId: tabIds.get(page) ?? 'tab-unknown',
    url: page.url(),
    title: await page.title().catch(() => ''),
  });

  const findTab = (tabId: string): Page | null => context.pages().find((page) => tabIds.get(page) === tabId) ?? null;

  const screenshot = async (page: Page): Promise<{ readonly mediaType: 'image/jpeg'; readonly base64: string }> => ({
    mediaType: 'image/jpeg',
    base64: (await page.screenshot({ type: 'jpeg', quality: SCREENSHOT_QUALITY })).toString('base64'),
  });

  const navigate = async (page: Page, url: string): Promise<BrowserControlResponse | null> => {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
      return null;
    } catch (error) {
      return refused('navigation-denied', errorText(error));
    }
  };

  const ok = (result: BrowserOperationResult): BrowserControlResponse => ({ ok: true, result });

  const run = async (operation: BrowserOperation): Promise<BrowserControlResponse> => {
    const page = await activePage();
    try {
      switch (operation.kind) {
        case 'navigate': {
          const failure = await navigate(page, operation.url);
          return failure ?? ok({ kind: 'navigate', page: await summarize(page) });
        }
        case 'click': {
          const target = page.locator(`aria-ref=${operation.ref}`);
          if ((await target.count()) === 0) return refused('element-not-found', `No element with ref ${operation.ref}; take a fresh browser_read`);
          await target.click({ timeout: ACTION_TIMEOUT_MS });
          await page.waitForLoadState('domcontentloaded', { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined);
          return ok({ kind: 'click', page: await summarize(page) });
        }
        case 'type': {
          const target = page.locator(`aria-ref=${operation.ref}`);
          if ((await target.count()) === 0) return refused('element-not-found', `No element with ref ${operation.ref}; take a fresh browser_read`);
          await target.fill(operation.text, { timeout: ACTION_TIMEOUT_MS });
          if (operation.submit) {
            await target.press('Enter', { timeout: ACTION_TIMEOUT_MS });
            await page.waitForLoadState('domcontentloaded', { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined);
          }
          return ok({ kind: 'type', page: await summarize(page) });
        }
        case 'read': {
          const snapshot = await page.ariaSnapshot({ mode: 'ai', timeout: ACTION_TIMEOUT_MS });
          const truncated = snapshot.length > MAX_SNAPSHOT_CHARS;
          return ok({ kind: 'read', page: await summarize(page), snapshot: truncated ? snapshot.slice(0, MAX_SNAPSHOT_CHARS) : snapshot, truncated });
        }
        case 'screenshot':
          return ok({ kind: 'screenshot', page: await summarize(page), image: await screenshot(page) });
        case 'tabs': {
          if (operation.action === 'open') {
            const opened = await context.newPage();
            const failure = await navigate(opened, operation.url);
            if (failure !== null) return failure;
          } else if (operation.action === 'select' || operation.action === 'close') {
            const tab = findTab(operation.tabId);
            if (tab === null) return refused('tab-not-found', `No tab ${operation.tabId}`);
            if (operation.action === 'select') {
              active = tab;
              await tab.bringToFront();
            } else {
              await tab.close();
            }
          }
          const pages = context.pages();
          return ok({
            kind: 'tabs',
            tabs: await Promise.all(pages.map(summarize)),
            activeTabId: active === null ? null : (tabIds.get(active) ?? null),
          });
        }
      }
    } catch (error) {
      return refused('operation-failed', errorText(error));
    }
  };

  const frame = async (): Promise<BrowserFrame> => {
    const page = await activePage();
    return { image: await screenshot(page), page: await summarize(page) };
  };

  const humanInput = async (input: HumanInput): Promise<void> => {
    const page = await activePage();
    switch (input.kind) {
      case 'click':
        await page.mouse.click(input.x, input.y);
        return;
      case 'text':
        await page.keyboard.type(input.text);
        return;
      case 'key':
        await page.keyboard.press(input.key);
        return;
    }
  };

  const close = async (): Promise<void> => {
    await context.close().catch(() => undefined);
    await rm(profileDir, { recursive: true, force: true });
  };

  return { run, frame, humanInput, close };
};
