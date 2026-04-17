import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { User } from 'lucide-react';
import { SettingsRow } from '../page';

const baseItem = {
  title: 'Account',
  description: 'Manage your account and profile',
  icon: User,
  href: '/settings/account',
  available: true,
};

describe('SettingsRow contrast affordances', () => {
  it('pairs hover bg with accent-foreground so hovered body text passes WCAG AA', () => {
    const { container } = render(<SettingsRow item={baseItem} index={0} />);
    const row = container.firstElementChild as HTMLElement;
    expect(row.className).toContain('hover:bg-accent');
    expect(row.className).toContain('hover:text-accent-foreground');
    expect(row.className).toContain('group');
  });

  it('flips the description to accent-foreground on hover (not just muted-foreground)', () => {
    render(<SettingsRow item={baseItem} index={0} />);
    const description = screen.getByText('Manage your account and profile');
    expect(description.className).toContain('text-muted-foreground');
    expect(description.className).toContain('group-hover:text-accent-foreground');
  });

  it('does not apply the hover flip to unavailable rows', () => {
    const { container } = render(
      <SettingsRow item={{ ...baseItem, available: false }} index={0} />,
    );
    const row = container.firstElementChild as HTMLElement;
    expect(row.className).not.toContain('hover:bg-accent');
    expect(row.className).not.toContain('hover:text-accent-foreground');
  });
});
