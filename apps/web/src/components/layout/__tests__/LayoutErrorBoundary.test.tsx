import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LayoutErrorBoundary } from '../LayoutErrorBoundary';

const { mockCaptureException } = vi.hoisted(() => ({ mockCaptureException: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: mockCaptureException }));

function Bomb(): never {
  throw new Error('boundary boom');
}

describe('LayoutErrorBoundary', () => {
  beforeEach(() => {
    mockCaptureException.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'group').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
  });

  it('reports the caught error to Sentry via componentDidCatch', () => {
    render(
      <LayoutErrorBoundary>
        <Bomb />
      </LayoutErrorBoundary>
    );

    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error));
    expect(mockCaptureException.mock.calls[0][0].message).toBe('boundary boom');
  });

  it('renders children normally when no error occurs', () => {
    render(
      <LayoutErrorBoundary>
        <div>all good</div>
      </LayoutErrorBoundary>
    );

    expect(screen.getByText('all good')).toBeInTheDocument();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  // Regression: clearCorruptedState only ever removed 'layout-storage', so a corrupted
  // 'agent-workspace-storage' or 'drive-storage' localStorage entry (the two other
  // persisted Zustand stores backing the layout this boundary wraps) survived "Try
  // Again"/"Reload Page" and re-threw the identical crash on every subsequent load.
  it('clears the agent-workspace and drive persisted stores alongside layout-storage on catch', () => {
    localStorage.setItem('layout-storage', 'x');
    localStorage.setItem('agent-workspace-storage', 'x');
    localStorage.setItem('drive-storage', 'x');

    render(
      <LayoutErrorBoundary>
        <Bomb />
      </LayoutErrorBoundary>
    );

    expect(localStorage.getItem('layout-storage')).toBeNull();
    expect(localStorage.getItem('agent-workspace-storage')).toBeNull();
    expect(localStorage.getItem('drive-storage')).toBeNull();
  });
});
