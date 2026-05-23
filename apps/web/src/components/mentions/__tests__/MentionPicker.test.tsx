import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MentionPicker } from '../MentionPicker';
import type { MentionSuggestion } from '@/types/mentions';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';

const mockFetch = fetchWithAuth as ReturnType<typeof vi.fn>;

const makeResponse = (items: MentionSuggestion[]) =>
  Promise.resolve({ json: () => Promise.resolve(items) });

const userSuggestion: MentionSuggestion = {
  id: 'user-1',
  label: 'Alice',
  type: 'user',
  data: {},
};

const pageSuggestion: MentionSuggestion = {
  id: 'page-1',
  label: 'Project Alpha',
  type: 'page',
  data: { pageType: 'DOCUMENT', driveId: 'drive-1' },
};

const everyoneSuggestion: MentionSuggestion = {
  id: 'drive-1',
  label: 'everyone',
  type: 'everyone',
  data: { driveId: 'drive-1' },
};

describe('MentionPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReturnValue(makeResponse([]));
  });

  describe('initial render', () => {
    it('should render a search input', () => {
      render(
        <MentionPicker
          driveId="drive-1"
          onMentionSelect={vi.fn()}
        />
      );
      expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
    });

    it('should render all four type tabs', () => {
      render(
        <MentionPicker
          driveId="drive-1"
          onMentionSelect={vi.fn()}
        />
      );
      expect(screen.getByRole('tab', { name: /all/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /people/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /pages/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /groups/i })).toBeInTheDocument();
    });
  });

  describe('search input', () => {
    it('should fetch with the typed query', async () => {
      const user = userEvent.setup();
      render(
        <MentionPicker
          driveId="drive-1"
          onMentionSelect={vi.fn()}
        />
      );

      await user.type(screen.getByPlaceholderText(/search/i), 'Alice');

      await vi.waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('q=Alice')
        );
      });
    });

    it('should include the driveId in the fetch URL', async () => {
      render(
        <MentionPicker
          driveId="my-drive"
          onMentionSelect={vi.fn()}
        />
      );

      await vi.waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('driveId=my-drive')
        );
      });
    });
  });

  describe('results list', () => {
    it('should display user suggestions returned by the API', async () => {
      mockFetch.mockReturnValue(makeResponse([userSuggestion]));

      render(
        <MentionPicker
          driveId="drive-1"
          onMentionSelect={vi.fn()}
        />
      );

      await screen.findByText('Alice');
    });

    it('should display an empty state when API returns no results', async () => {
      mockFetch.mockReturnValue(makeResponse([]));

      render(
        <MentionPicker
          driveId="drive-1"
          onMentionSelect={vi.fn()}
        />
      );

      await screen.findByText(/no results/i);
    });

    it('should call onMentionSelect with the suggestion when a result is clicked', async () => {
      const onMentionSelect = vi.fn();
      mockFetch.mockReturnValue(makeResponse([userSuggestion]));
      const user = userEvent.setup();

      render(
        <MentionPicker
          driveId="drive-1"
          onMentionSelect={onMentionSelect}
        />
      );

      await user.click(await screen.findByText('Alice'));

      expect(onMentionSelect).toHaveBeenCalledWith(userSuggestion);
    });
  });

  describe('tab filtering', () => {
    it('should request only user type when People tab is active', async () => {
      const user = userEvent.setup();
      render(
        <MentionPicker
          driveId="drive-1"
          onMentionSelect={vi.fn()}
        />
      );

      await user.click(screen.getByRole('tab', { name: /people/i }));

      await vi.waitFor(() => {
        const lastCall = mockFetch.mock.calls.at(-1)?.[0] as string;
        expect(lastCall).toContain('types=user');
        expect(lastCall).not.toContain('page');
      });
    });

    it('should request only page type when Pages tab is active', async () => {
      const user = userEvent.setup();
      render(
        <MentionPicker
          driveId="drive-1"
          onMentionSelect={vi.fn()}
        />
      );

      await user.click(screen.getByRole('tab', { name: /pages/i }));

      await vi.waitFor(() => {
        const lastCall = mockFetch.mock.calls.at(-1)?.[0] as string;
        expect(lastCall).toContain('types=page');
      });
    });

    it('should request everyone and role types when Groups tab is active', async () => {
      const user = userEvent.setup();
      render(
        <MentionPicker
          driveId="drive-1"
          onMentionSelect={vi.fn()}
        />
      );

      await user.click(screen.getByRole('tab', { name: /groups/i }));

      await vi.waitFor(() => {
        const lastCall = mockFetch.mock.calls.at(-1)?.[0] as string;
        expect(lastCall).toContain('everyone');
        expect(lastCall).toContain('role');
      });
    });
  });

  describe('keyboard navigation', () => {
    it('should select the next item on ArrowDown', async () => {
      mockFetch.mockReturnValue(makeResponse([userSuggestion, pageSuggestion]));
      const user = userEvent.setup();

      render(
        <MentionPicker
          driveId="drive-1"
          onMentionSelect={vi.fn()}
        />
      );

      await screen.findByText('Alice');
      await user.keyboard('{ArrowDown}');

      const items = screen.getAllByRole('option');
      expect(items[1]).toHaveAttribute('aria-selected', 'true');
    });

    it('should confirm selection with Enter', async () => {
      const onMentionSelect = vi.fn();
      mockFetch.mockReturnValue(makeResponse([userSuggestion, pageSuggestion]));
      const user = userEvent.setup();

      render(
        <MentionPicker
          driveId="drive-1"
          onMentionSelect={onMentionSelect}
        />
      );

      await screen.findByText('Alice');
      await user.keyboard('{Enter}');

      expect(onMentionSelect).toHaveBeenCalledWith(userSuggestion);
    });
  });

  describe('group mention rendering', () => {
    it('should render everyone suggestion with an @ badge', async () => {
      mockFetch.mockReturnValue(makeResponse([everyoneSuggestion]));

      render(
        <MentionPicker
          driveId="drive-1"
          onMentionSelect={vi.fn()}
        />
      );

      await screen.findByText('everyone');
      expect(screen.getByTestId('group-badge')).toBeInTheDocument();
    });
  });
});
