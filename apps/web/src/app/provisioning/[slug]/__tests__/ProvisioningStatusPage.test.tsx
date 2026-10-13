// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Suspense } from 'react';

const swrState: { data?: { slug: string; status: string }; error?: Error } = {};

vi.mock('swr', () => ({
  default: () => swrState,
}));

import ProvisioningStatusPage from '../page';

// A thenable already marked fulfilled lets React's `use()` unwrap params synchronously.
const resolvedParams = Object.assign(Promise.resolve({ slug: 'studio' }), {
  status: 'fulfilled' as const,
  value: { slug: 'studio' },
});

const renderPage = () =>
  render(
    <Suspense fallback={null}>
      <ProvisioningStatusPage params={resolvedParams} />
    </Suspense>,
  );

beforeEach(() => {
  delete swrState.data;
  delete swrState.error;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ProvisioningStatusPage', () => {
  it('given the tenant is provisioning and Imago is on, should say so with the host and the 3s polling line', async () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', 'true');
    swrState.data = { slug: 'studio', status: 'provisioning' };
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Setting up your environment' })).toBeInTheDocument();
    expect(screen.getByText(/studio\.pagespace\.ai · checking every 3s/)).toBeInTheDocument();
  });

  it('given the tenant is active, should link to the environment', async () => {
    swrState.data = { slug: 'studio', status: 'active' };
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Your environment is ready!' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to your environment' })).toHaveAttribute(
      'href',
      'https://studio.pagespace.ai',
    );
  });

  it('given provisioning failed, should show the failure copy', async () => {
    swrState.data = { slug: 'studio', status: 'failed' };
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
  });

  it('given the status route errors, should say the status cannot be checked', async () => {
    swrState.error = new Error('Status check failed (500)');
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Unable to check provisioning status' })).toBeInTheDocument();
  });

  it('given Imago is on, should render the v3 active card with the URL line', async () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', 'true');
    swrState.data = { slug: 'studio', status: 'active' };
    renderPage();
    expect(await screen.findByText('https://studio.pagespace.ai')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to your environment' })).toHaveClass('bg-[oklch(0.50_0.16_235)]');
  });
});
