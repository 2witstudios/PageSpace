import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

describe('cookie banner (ConsentProvider)', () => {
  beforeEach(resetStore);

  it('given no consent cookie, shows the Cookie consent dialog with its three actions', async () => {
    render(<ConsentProvider />);
    const dialog = await screen.findByRole('dialog', { name: 'Cookie consent' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Customize' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject optional' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept all' })).toBeInTheDocument();
  });

  it('given Customize, shows necessary (checked, disabled), analytics and preferences', async () => {
    render(<ConsentProvider />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    expect(screen.getByRole('checkbox', { name: /Strictly necessary/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Strictly necessary/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Analytics/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Preferences/ })).not.toBeChecked();
  });

  it('given Save choices, persists to the cookie and hides the banner', async () => {
    render(<ConsentProvider />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Analytics/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save choices' }));
    expect(screen.queryByRole('dialog', { name: 'Cookie consent' })).not.toBeInTheDocument();
    expect(document.cookie).toMatch(/consent/i);
    expect(useConsentStore.getState().state.categories.analytics).toBe(true);
  });

  it('given a decision, reopenBanner shows it again seeded with current choices', async () => {
    render(<ConsentProvider />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept all' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    act(() => useConsentStore.getState().reopenBanner());
    expect(await screen.findByRole('dialog', { name: 'Cookie consent' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    expect(screen.getByRole('checkbox', { name: /Analytics/ })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Reject optional' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(useConsentStore.getState().reopenRequested).toBe(false);
  });
});
