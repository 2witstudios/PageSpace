import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React, { useRef, useState } from 'react';
import { useCommandSuggestion } from '@/hooks/useCommandSuggestion';
import { COMMAND_TOKEN_TYPE, type TrackedToken } from '@/lib/tokens/message-tokens';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: fetchMock }));

// jsdom rects are all zero — one stubbed position is enough for open().
vi.mock('@/services/positioningService', () => ({
  positioningService: {
    calculateTextareaPosition: () => ({ top: 0, left: 0 }),
  },
}));

const suggestionsJson = (suggestions: unknown[]) =>
  Promise.resolve({ ok: true, json: async () => ({ suggestions }) });

const BTW = {
  id: 'builtin:btw',
  trigger: 'btw',
  description: 'Ask a side question without interrupting the run',
  scope: 'builtin',
  clientHandled: true,
};
const DRIVE = {
  id: 'drive-1',
  trigger: 'release-notes',
  description: 'Cut release notes',
  scope: 'drive',
};

function Harness({ onTokenInserted }: { onTokenInserted: (t: TrackedToken) => void }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState('');
  const tokens = useRef<TrackedToken[]>([]);
  const suggestion = useCommandSuggestion({
    inputRef,
    enabled: true,
    enterSelects: true,
    getTokens: () => tokens.current,
    onValueChange: setValue,
    onTokenInserted: (token) => {
      tokens.current = [...tokens.current, token];
      onTokenInserted(token);
    },
  });
  return (
    <div>
      <textarea
        ref={inputRef}
        data-testid="picker-textarea"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          suggestion.handleInput(e.target.value, 'insertText');
        }}
        onKeyDown={(e) => suggestion.handleKeyDown(e)}
      />
      <span data-testid="picker-open">{String(suggestion.isOpen)}</span>
      <span data-testid="picker-items">{suggestion.items.map((i) => i.trigger).join(',')}</span>
      <button
        data-testid="picker-select-first"
        onClick={() => {
          const first = suggestion.items[0];
          if (first) suggestion.actions.select(first);
        }}
      />
    </div>
  );
}

const type = (text: string) => {
  fireEvent.change(screen.getByTestId('picker-textarea'), { target: { value: text } });
};

/**
 * The /btw built-in must insert as PLAIN TEXT: the composer's pre-send
 * interception matches the literal `/btw ` — a tracked command chip would
 * serialize to `/[btw](builtin:btw)` and never fire. Ordinary commands keep
 * the chip path, and the picker's Enter-fallthrough stays intact.
 */
describe('useCommandSuggestion /btw (client-handled) insertion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers the /btw built-in for the /b query', async () => {
    fetchMock.mockReturnValue(suggestionsJson([BTW, DRIVE]));
    render(<Harness onTokenInserted={vi.fn()} />);
    type('/');
    await waitFor(() =>
      expect(screen.getByTestId('picker-open').textContent).toBe('true')
    );
    type('/b');
    await waitFor(() =>
      expect(screen.getByTestId('picker-items').textContent).toContain('btw')
    );
  });

  it('selecting /btw inserts plain text and registers no command token', async () => {
    fetchMock.mockReturnValue(suggestionsJson([BTW, DRIVE]));
    const onTokenInserted = vi.fn();
    render(<Harness onTokenInserted={onTokenInserted} />);
    type('/');
    await waitFor(() =>
      expect(screen.getByTestId('picker-items').textContent).toContain('btw')
    );
    fireEvent.click(screen.getByTestId('picker-select-first'));
    expect((screen.getByTestId('picker-textarea') as HTMLTextAreaElement).value).toBe(
      '/btw '
    );
    expect(onTokenInserted).not.toHaveBeenCalled();
  });

  it('selecting an ordinary command still registers the chip token', async () => {
    fetchMock.mockReturnValue(suggestionsJson([DRIVE]));
    const onTokenInserted = vi.fn();
    render(<Harness onTokenInserted={onTokenInserted} />);
    type('/');
    await waitFor(() =>
      expect(screen.getByTestId('picker-items').textContent).toContain('release-notes')
    );
    fireEvent.click(screen.getByTestId('picker-select-first'));
    expect((screen.getByTestId('picker-textarea') as HTMLTextAreaElement).value).toBe(
      '/release-notes '
    );
    expect(onTokenInserted).toHaveBeenCalledTimes(1);
    expect(onTokenInserted.mock.calls[0][0]).toMatchObject({
      label: 'release-notes',
      type: COMMAND_TOKEN_TYPE,
    });
  });

  it('Enter falls through to send when no items match the query', async () => {
    fetchMock.mockReturnValue(suggestionsJson([BTW]));
    render(<Harness onTokenInserted={vi.fn()} />);
    type('/');
    await waitFor(() =>
      expect(screen.getByTestId('picker-open').textContent).toBe('true')
    );
    type('/zzz');
    // filterQuery is debounced 200ms — wait past it so the list empties.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(screen.getByTestId('picker-items').textContent).toBe('');
    const notPrevented = fireEvent.keyDown(screen.getByTestId('picker-textarea'), {
      key: 'Enter',
    });
    expect(notPrevented).toBe(true);
  });
});
