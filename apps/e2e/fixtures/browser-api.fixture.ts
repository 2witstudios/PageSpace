import { expect, type Page } from '@playwright/test';

/** Chromium sends localhost Secure cookies; Playwright's HTTP context does not. */
export async function browserGet(page: Page, path: string): Promise<{ status: number; body: string; coep: string | null }> {
  const response = await page.evaluate(async target => {
    const result = await fetch(target, { credentials: 'same-origin' });
    return { status: result.status, body: await result.text(), coep: result.headers.get('cross-origin-embedder-policy') };
  }, path);
  expect(response.status).toBe(200);
  return response;
}
