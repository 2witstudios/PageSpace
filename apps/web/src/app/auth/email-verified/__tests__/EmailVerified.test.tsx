// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import EmailVerified from '../page';

describe('EmailVerified page', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('given Imago is enabled, should show the v3 status card and send "Go to Dashboard" to /imago', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_V3_AUTH', 'true');
    render(<EmailVerified />);

    expect(screen.getByRole('heading', { level: 1, name: 'Email Verified!' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Dashboard' })).toHaveAttribute('href', '/imago');
  });

  it('given Imago is off, should keep the classic card and send "Go to Dashboard" to /dashboard', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_V3_AUTH', undefined);
    render(<EmailVerified />);

    expect(screen.getByText('Email Verified!')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Dashboard' })).toHaveAttribute('href', '/dashboard');
  });
});
