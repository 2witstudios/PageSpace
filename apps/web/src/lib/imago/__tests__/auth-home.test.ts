import { describe, it, expect, afterEach, vi } from 'vitest';
import { authHomePath } from '../auth-home';

describe('authHomePath', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('given Imago is enabled, should land in /imago', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', 'true');
    expect(authHomePath()).toBe('/imago');
  });

  it('given Imago is off, should keep the classic /dashboard', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', undefined);
    expect(authHomePath()).toBe('/dashboard');
  });
});
