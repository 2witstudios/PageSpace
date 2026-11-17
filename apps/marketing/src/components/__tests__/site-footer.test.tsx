import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

// A fixed web-app origin (the production default), set before the footer (and metadata.ts) are evaluated, so the assertion does not depend
// on the NEXT_PUBLIC_APP_URL of whoever runs the tests.
const { previousAppUrl } = vi.hoisted(() => {
  const previous = process.env.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_APP_URL = 'https://pagespace.ai';
  return { previousAppUrl: previous };
});
afterAll(() => {
  if (previousAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = previousAppUrl;
});

vi.mock('@/components/ThemeToggle', () => ({ ThemeToggle: () => null }));

import { SiteFooter } from '../SiteFooter';

describe('SiteFooter', () => {
  it('links the public content report page in the web app', () => {
    const html = renderToStaticMarkup(<SiteFooter />);
    expect(html).toMatch(/href="https:\/\/pagespace\.ai\/report"[^>]*>Report content</);
  });
});
