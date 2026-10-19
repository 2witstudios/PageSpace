import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../AuthShell', () => ({
  AuthShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="classic-shell">{children}</div>
  ),
}));

import { AuthLayout } from '../AuthLayout';

describe('AuthLayout', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('given Imago is off, renders the classic AuthShell unchanged', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_V3_AUTH', undefined);
    render(<AuthLayout><p>card</p></AuthLayout>);
    expect(screen.getByTestId('classic-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('auth-frame-spine')).not.toBeInTheDocument();
  });

  it('given Imago is off and a page that never had a shell, renders it bare as before', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_V3_AUTH', undefined);
    render(<AuthLayout classic="bare"><p>card</p></AuthLayout>);
    expect(screen.getByText('card')).toBeInTheDocument();
    expect(screen.queryByTestId('classic-shell')).not.toBeInTheDocument();
    expect(screen.queryByTestId('auth-frame-spine')).not.toBeInTheDocument();
  });

  it('given Imago is on, renders the v3 frame with only the spark tile on the spine', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_V3_AUTH', 'true');
    render(<AuthLayout><p>card</p></AuthLayout>);
    expect(screen.queryByTestId('classic-shell')).not.toBeInTheDocument();
    const spine = screen.getByTestId('auth-frame-spine');
    expect(spine).toHaveClass('w-[72px]');
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByRole('img', { name: 'PageSpace' })).toBeInTheDocument();
    expect(screen.getByTestId('auth-frame-card')).toHaveClass('max-w-[400px]');
    expect(screen.getByText('card')).toBeInTheDocument();
  });

  it('given a signed-in viewer, shows the Signed in as avatar only in the v3 frame', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_V3_AUTH', 'true');
    render(<AuthLayout signedInAs="Ada Lovelace">x</AuthLayout>);
    expect(screen.getByRole('img', { name: 'Signed in as Ada Lovelace' })).toHaveTextContent('A');
  });

  it('given any non-true flag value, stays classic', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_V3_AUTH', '1');
    render(<AuthLayout>x</AuthLayout>);
    expect(screen.getByTestId('classic-shell')).toBeInTheDocument();
  });
});
