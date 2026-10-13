/**
 * The v3 cookie banner (C-Auth-Cookies board) renders only when Imago is enabled;
 * the classic banner classes are asserted in CookieBanner.test.tsx and must not change.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ConsentProvider from '@/components/providers/ConsentProvider';
import { useConsentStore } from '@/stores/useConsentStore';
import { defaultConsentState } from '@pagespace/lib/consent';

function resetStore() {
  document.cookie.split(';').forEach((c) => {
    const name = c.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; Max-Age=0; path=/`;
  });
  useConsentStore.setState({ state: defaultConsentState(), reopenRequested: false });
}

describe('cookie banner — v3 frame', () => {
  beforeEach(() => {
    resetStore();
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', 'true');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('given no decision, shows a floating rounded dialog rather than a full-width bottom bar', async () => {
    render(<ConsentProvider />);
    const dialog = await screen.findByRole('dialog', { name: 'Cookie consent' });
    expect(dialog).toHaveClass('inset-x-4', 'bottom-4', 'rounded-xl');
    expect(dialog).not.toHaveClass('border-t');
    expect(screen.getByRole('button', { name: 'Accept all' })).toHaveClass('bg-[oklch(0.50_0.16_235)]');
  });

  it('given Customize then Save choices, keeps the three checkboxes and persists the decision', async () => {
    render(<ConsentProvider />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.getByRole('checkbox', { name: /Strictly necessary/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: /Preferences/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save choices' }));

    expect(screen.queryByRole('dialog', { name: 'Cookie consent' })).not.toBeInTheDocument();
    expect(useConsentStore.getState().state.categories.preferences).toBe(true);
  });
});
