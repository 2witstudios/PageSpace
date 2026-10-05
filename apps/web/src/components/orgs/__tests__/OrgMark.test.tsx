import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OrgMark, orgInitial } from '../OrgMark';

describe('OrgMark', () => {
  it('shows the org initial on the primary color, named for assistive tech', () => {
    render(<OrgMark name="Northwind Labs" />);
    const mark = screen.getByRole('img', { name: 'Northwind Labs' });
    expect(mark.textContent).toBe('N');
    expect(mark.querySelector('[data-slot="avatar-fallback"]')?.className).toContain('bg-primary');
    expect(mark.querySelector('[data-slot="avatar-fallback"]')?.className).toContain('text-primary-foreground');
  });

  it('uses only semantic tokens, so it holds in light and dark', () => {
    const { container } = render(<OrgMark name="Northwind Labs" />);
    expect(container.innerHTML).not.toMatch(/\b(bg|text)-(blue|gray|slate|zinc|neutral|white|black)\b/);
  });

  it('falls back to the initial when the avatar URL does not load (a broken or disallowed URL)', () => {
    // jsdom never loads images, which is exactly the broken-URL case: the Avatar keeps its fallback.
    render(<OrgMark name="Northwind Labs" avatarUrl="https://cdn.example.com/missing.png" />);
    const mark = screen.getByRole('img', { name: 'Northwind Labs' });
    expect(mark.textContent).toBe('N');
    expect(mark.querySelector('img')).toBeNull();
  });

  it('is hidden from assistive tech when decorative (the name is already beside it)', () => {
    const { container } = render(<OrgMark name="Northwind Labs" decorative />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });

  it('trims the name and falls back to a question mark when it has no letters', () => {
    render(<OrgMark name="  acme" />);
    expect(screen.getByRole('img', { name: 'acme' }).textContent).toBe('A');
    render(<OrgMark name="   " />);
    expect(screen.getByRole('img', { name: 'Organization' }).textContent).toBe('?');
  });

  it('takes the first grapheme, so an emoji name shows the whole emoji', () => {
    render(<OrgMark name="🚀 Rocket" />);
    expect(screen.getByRole('img', { name: '🚀 Rocket' }).textContent).toBe('🚀');
    expect(orgInitial('👩‍💻 Devs')).toBe('👩‍💻');
    expect(orgInitial('élan')).toBe('É');
  });

  it('sizes match the canvas org mark: sm 18px, md 24px, lg 40px', () => {
    const sizes = { sm: 'h-[18px]', md: 'h-6', lg: 'h-10' } as const;
    for (const [size, cls] of Object.entries(sizes)) {
      const { container, unmount } = render(<OrgMark name="N" size={size as keyof typeof sizes} />);
      expect((container.firstElementChild as HTMLElement).className).toContain(cls);
      unmount();
    }
  });
});
