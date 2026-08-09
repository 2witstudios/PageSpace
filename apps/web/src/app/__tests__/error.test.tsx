import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ErrorPage from '../error';

const { mockCaptureException } = vi.hoisted(() => ({ mockCaptureException: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: mockCaptureException }));

describe('ErrorPage (route-segment boundary)', () => {
  beforeEach(() => {
    mockCaptureException.mockClear();
  });

  it('reports the caught error to Sentry', () => {
    const error = Object.assign(new Error('boom'), { digest: 'digest-123' });
    render(<ErrorPage error={error} reset={vi.fn()} />);

    expect(mockCaptureException).toHaveBeenCalledWith(error);
  });

  it('does not report to Sentry more than once per error instance', () => {
    const error = new Error('boom');
    const { rerender } = render(<ErrorPage error={error} reset={vi.fn()} />);
    rerender(<ErrorPage error={error} reset={vi.fn()} />);

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});
