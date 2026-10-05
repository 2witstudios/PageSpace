import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OrgMark } from '../OrgMark';

describe('OrgMark', () => {
  it('shows the org initial on the primary color, named for assistive tech', () => {
    render(<OrgMark name="Northwind Labs" />);
    const mark = screen.getByRole('img', { name: 'Northwind Labs' });
    expect(mark.textContent).toBe('N');
    expect(mark.className).toContain('bg-primary');
    expect(mark.className).toContain('text-primary-foreground');
  });

  it('uses only semantic tokens, so it holds in light and dark', () => {
    const { container } = render(<OrgMark name="Northwind Labs" />);
    expect(container.innerHTML).not.toMatch(/\b(bg|text)-(blue|gray|slate|zinc|neutral|white|black)\b/);
  });

  it('renders the avatar when there is one, with the org name as its alt text', () => {
    render(<OrgMark name="Northwind Labs" avatarUrl="https://cdn.example.com/nw.png" />);
    const img = screen.getByRole('img', { name: 'Northwind Labs' }) as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.src).toBe('https://cdn.example.com/nw.png');
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

  it('sizes match the canvas org mark: sm 18px, md 24px, lg 40px', () => {
    const sizes = { sm: 'h-[18px]', md: 'h-6', lg: 'h-10' } as const;
    for (const [size, cls] of Object.entries(sizes)) {
      const { container, unmount } = render(<OrgMark name="N" size={size as keyof typeof sizes} />);
      expect((container.firstElementChild as HTMLElement).className).toContain(cls);
      unmount();
    }
  });
});
