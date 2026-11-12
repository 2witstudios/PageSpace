import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/ThemeToggle', () => ({ ThemeToggle: () => null }));

import { SiteFooter } from '../SiteFooter';

describe('SiteFooter', () => {
  it('links the public content report page in the web app', () => {
    const html = renderToStaticMarkup(<SiteFooter />);
    expect(html).toMatch(/href="https:\/\/pagespace\.ai\/report"[^>]*>Report content</);
  });
});
