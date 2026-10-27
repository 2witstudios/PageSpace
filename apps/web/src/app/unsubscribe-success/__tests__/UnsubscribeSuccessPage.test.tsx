// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const searchParamsState: { type: string | null } = { type: 'PAGE_SHARED' };

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({
    get: (key: string) => (key === 'type' ? searchParamsState.type : null),
  }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import UnsubscribeSuccessPage from '../page';

afterEach(() => {
  vi.unstubAllEnvs();
  searchParamsState.type = 'PAGE_SHARED';
});

describe('UnsubscribeSuccessPage', () => {
  it.each([
    ['PAGE_SHARED', 'Page Shared'],
    ['NEW_DIRECT_MESSAGE', 'Direct Messages'],
    ['PRODUCT_UPDATE', 'Product Updates'],
  ])('given type %s, should name the %s emails it stopped', (type, label) => {
    searchParamsState.type = type;
    render(<UnsubscribeSuccessPage />);
    expect(screen.getByRole('heading', { name: 'Unsubscribed Successfully' })).toBeInTheDocument();
    expect(screen.getByText(label, { selector: 'strong' })).toBeInTheDocument();
  });

  it('given Imago is off, should link both actions to the classic settings and dashboard', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_V3_AUTH', undefined);
    render(<UnsubscribeSuccessPage />);
    expect(screen.getByRole('link', { name: 'Manage All Preferences' })).toHaveAttribute('href', '/settings/notifications');
    expect(screen.getByRole('link', { name: 'Return to PageSpace' })).toHaveAttribute('href', '/dashboard');
  });

  it('given Imago is on, should point Manage All Preferences at /imago/account/notifications', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_V3_AUTH', 'true');
    render(<UnsubscribeSuccessPage />);
    expect(screen.getByRole('link', { name: 'Manage All Preferences' })).toHaveAttribute(
      'href',
      '/imago/account/notifications',
    );
    expect(screen.getByRole('link', { name: 'Return to PageSpace' })).toBeInTheDocument();
  });
});
