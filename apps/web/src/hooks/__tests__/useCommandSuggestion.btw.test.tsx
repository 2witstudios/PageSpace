import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React, { useRef, useState } from 'react';
import { useCommandSuggestion } from '@/hooks/useCommandSuggestion';
import { COMMAND_TOKEN_TYPE, type TrackedToken } from '@/lib/tokens/message-tokens';
import type { CommandSuggestionItem } from '@/lib/commands/command-picker-core';

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

const BTW: CommandSuggestionItem = {
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
const BETA = {
  id: 'drive-2',
  trigger: 'beta',
  description: 'Beta things',
  scope: 'drive',
};

function Harness({
  onTokenInserted,
  allowClientHandledCommands,
}: {
  onTokenInserted: (t: TrackedToken) => void;
  allowClientHandledCommands?: boolean;
}) {
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
    allowClientHandledCommands,
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
      {/* Bypasses the items list so the select() leading-trigger backstop can
          be exercised even when the filter already hides /btw mid-text. */}
      <button
        data-testid="picker-select-btw-direct"
        onClick={() => suggestion.actions.select({ ...BTW })}
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
    render(<Harness onTokenInserted={vi.fn()} allowClientHandledCommands />);
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
    render(<Harness onTokenInserted={onTokenInserted} allowClientHandledCommands />);
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

/**
 * /btw is client-handled: the composer intercepts the literal `/btw ` only at
 * the START of the (trimmed) message. Mid-text it would go out as an ordinary
 * primary-chat message, so the picker must only offer/select it at a leading
 * trigger (only whitespace before the `/` — after a newline still counts).
 */
describe('useCommandSuggestion /btw leading-trigger gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers /btw at a leading trigger after a newline', async () => {
    fetchMock.mockReturnValue(suggestionsJson([BTW]));
    render(<Harness onTokenInserted={vi.fn()} allowClientHandledCommands />);
    type('\n/b');
    await waitFor(() =>
      expect(screen.getByTestId('picker-open').textContent).toBe('true')
    );
    // filterQuery is debounced 200ms — wait past it so the list reflects the
    // typed query and not the open-time empty query.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(screen.getByTestId('picker-items').textContent).toContain('btw');
  });

  it('hides /btw mid-text while ordinary commands stay offered', async () => {
    fetchMock.mockReturnValue(suggestionsJson([BTW, BETA]));
    render(<Harness onTokenInserted={vi.fn()} allowClientHandledCommands />);
    type('hello /b');
    await waitFor(() =>
      expect(screen.getByTestId('picker-open').textContent).toBe('true')
    );
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(screen.getByTestId('picker-items').textContent).toContain('beta');
    expect(screen.getByTestId('picker-items').textContent).not.toContain('btw');
  });

  it('select() no-ops on /btw mid-text (backstop: closes the picker, inserts nothing)', async () => {
    fetchMock.mockReturnValue(suggestionsJson([BTW]));
    render(<Harness onTokenInserted={vi.fn()} allowClientHandledCommands />);
    type('hello /b');
    await waitFor(() =>
      expect(screen.getByTestId('picker-open').textContent).toBe('true')
    );
    fireEvent.click(screen.getByTestId('picker-select-btw-direct'));
    expect((screen.getByTestId('picker-textarea') as HTMLTextAreaElement).value).toBe(
      'hello /b'
    );
    expect(screen.getByTestId('picker-open').textContent).toBe('false');
  });
});

/**
 * Surface capability gate: client-handled commands fire via the composer's
 * pre-send interception, which only some surfaces own. Surfaces without it
 * (e.g. ChannelInput) must never be offered /btw.
 */
describe('useCommandSuggestion allowClientHandledCommands gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('excludes clientHandled suggestions by default', async () => {
    fetchMock.mockReturnValue(suggestionsJson([BTW, DRIVE]));
    render(<Harness onTokenInserted={vi.fn()} />);
    type('/');
    await waitFor(() =>
      expect(screen.getByTestId('picker-items').textContent).toContain('release-notes')
    );
    expect(screen.getByTestId('picker-items').textContent).not.toContain('btw');
  });

  it('offers clientHandled suggestions when the surface opts in', async () => {
    fetchMock.mockReturnValue(suggestionsJson([BTW, DRIVE]));
    render(<Harness onTokenInserted={vi.fn()} allowClientHandledCommands />);
    type('/');
    await waitFor(() =>
      expect(screen.getByTestId('picker-items').textContent).toContain('btw')
    );
  });
});
