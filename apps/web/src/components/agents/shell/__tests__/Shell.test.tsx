import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const socketState = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => socketState.current,
}));

vi.mock('../XtermTerminal', () => ({
  default: ({ shellId }: { shellId: string }) => <div data-testid="xterm-terminal">{shellId}</div>,
}));

import Shell from '../Shell';

beforeEach(() => {
  socketState.current = null;
});

describe('Shell', () => {
  it('shows a connecting placeholder while the socket has not resolved yet', () => {
    render(<Shell shellId="shell-1" />);
    expect(screen.getByTestId('shell-connecting')).toBeInTheDocument();
    expect(screen.queryByTestId('xterm-terminal')).not.toBeInTheDocument();
  });

  it('renders XtermTerminal keyed by shellId once the socket resolves', () => {
    socketState.current = { connected: true };
    render(<Shell shellId="shell-1" />);
    expect(screen.getByTestId('xterm-terminal')).toHaveTextContent('shell-1');
    expect(screen.queryByTestId('shell-connecting')).not.toBeInTheDocument();
  });
});
