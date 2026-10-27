import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CommandChip } from '../CommandChip';

const push = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('swr', () => ({
  default: () => ({
    data: {
      results: {
        'command-1': {
          state: 'ok',
          trigger: 'release-checklist',
          description: 'Run the release checklist.',
          scope: 'user',
          enabled: true,
          entryPageId: 'page-1',
          entryPageTrashed: false,
          viewerCanViewEntryPage: true,
        },
      },
    },
  }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('CommandChip', () => {
  it('renders a navigable text-only pill for a resolved command', () => {
    render(<CommandChip commandId="command-1" label="release-checklist" />);

    const chip = screen.getByRole('link', { name: /release-checklist/i });

    expect(chip).toHaveTextContent('/release-checklist');
    expect(chip).toHaveAttribute('href', '/p/page-1');
    expect(chip.querySelector('svg')).toBeNull();
  });
});
