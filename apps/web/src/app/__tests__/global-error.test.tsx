import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCaptureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({ captureException: mockCaptureException }));

describe('GlobalError', () => {
  beforeEach(() => {
    mockCaptureException.mockClear();
  });

  it('exports a default function component', async () => {
    const mod = await import('../global-error');
    expect(typeof mod.default).toBe('function');
  });

  it('component name is GlobalError', async () => {
    const mod = await import('../global-error');
    expect(mod.default.name).toBe('GlobalError');
  });
});
