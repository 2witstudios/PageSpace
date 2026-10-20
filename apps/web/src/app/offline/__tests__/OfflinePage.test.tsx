// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('framer-motion', () => ({}));

import OfflinePage from '../page';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('OfflinePage', () => {
  it('given the app is offline, should say so and offer Try again', () => {
    render(<OfflinePage />);
    expect(screen.getByRole('heading', { name: "You're offline" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('given Imago is on, should render the v3 secondary Try again button', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_V3_AUTH', 'true');
    render(<OfflinePage />);
    expect(screen.getByRole('button', { name: 'Try again' })).toHaveClass('border-[oklch(0.90_0.005_230)]');
  });
});
