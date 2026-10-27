import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MentionPickerPortal } from '../MentionPickerPortal';
import type { MentionSuggestion } from '@/types/mentions';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';

const mockFetch = fetchWithAuth as ReturnType<typeof vi.fn>;

const makeResponse = (items: MentionSuggestion[]) =>
  Promise.resolve({ json: () => Promise.resolve(items) });

const mockPosition = { top: 100, left: 200 };

const userSuggestion: MentionSuggestion = {
  id: 'user-1',
  label: 'Alice',
  type: 'user',
  data: {},
};

describe('MentionPickerPortal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReturnValue(makeResponse([]));
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <MentionPickerPortal
        isOpen={false}
        position={mockPosition}
        driveId="drive-1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when open but position is null', () => {
    const { container } = render(
      <MentionPickerPortal
        isOpen={true}
        position={null}
        driveId="drive-1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the picker when open with a position', () => {
    render(
      <MentionPickerPortal
        isOpen={true}
        position={mockPosition}
        driveId="drive-1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByPlaceholderText('Search mentions...')).toBeInTheDocument();
  });

  it('pre-fills search input with initialQuery', () => {
    render(
      <MentionPickerPortal
        isOpen={true}
        position={mockPosition}
        driveId="drive-1"
        initialQuery="alice"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByPlaceholderText('Search mentions...')).toHaveValue('alice');
  });

  it('calls onSelect when a suggestion is clicked', async () => {
    mockFetch.mockReturnValue(makeResponse([userSuggestion]));
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <MentionPickerPortal
        isOpen={true}
        position={mockPosition}
        driveId="drive-1"
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText('Alice'));
    expect(onSelect).toHaveBeenCalledWith(userSuggestion);
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when Escape is pressed', async () => {
    const onClose = vi.fn();

    render(
      <MentionPickerPortal
        isOpen={true}
        position={mockPosition}
        driveId="drive-1"
        onSelect={vi.fn()}
        onClose={onClose}
      />,
    );

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('hides tabs when allowedTypes restricts to a single tab', () => {
    render(
      <MentionPickerPortal
        isOpen={true}
        position={mockPosition}
        driveId="drive-1"
        allowedTypes={['page']}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole('tab', { name: 'All' })).not.toBeInTheDocument();
  });
});
