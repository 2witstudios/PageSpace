import { describe, expect, it } from 'vitest';
import type { AuthProvider } from '@pagespace/sdk';
import { createLazyAuthProvider } from '../lazy-provider.js';

function fakeProvider(token: string): AuthProvider & { invalidations: number } {
  const provider = {
    invalidations: 0,
    async getAccessToken() {
      return token;
    },
    invalidate() {
      provider.invalidations += 1;
    },
  };
  return provider;
}

describe('createLazyAuthProvider', () => {
  it('defers resolution until the first getAccessToken call', async () => {
    let resolved = 0;
    const lazy = createLazyAuthProvider(async () => {
      resolved += 1;
      return fakeProvider('tok');
    });

    expect(resolved).toBe(0);
    await expect(lazy.getAccessToken()).resolves.toBe('tok');
    expect(resolved).toBe(1);
  });

  it('memoizes a successful resolution — later calls reuse the same inner provider', async () => {
    let resolved = 0;
    const lazy = createLazyAuthProvider(async () => {
      resolved += 1;
      return fakeProvider('tok');
    });

    await lazy.getAccessToken();
    await lazy.getAccessToken();
    await lazy.getAccessToken();
    expect(resolved).toBe(1);
  });

  it('dedupes concurrent first calls into one in-flight resolution (mirrors OAuthTokenProvider #inFlightRefresh)', async () => {
    let resolved = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const lazy = createLazyAuthProvider(async () => {
      resolved += 1;
      await gate;
      return fakeProvider('tok');
    });

    const first = lazy.getAccessToken();
    const second = lazy.getAccessToken();
    release();
    await expect(first).resolves.toBe('tok');
    await expect(second).resolves.toBe('tok');
    expect(resolved).toBe(1);
  });

  it('clears the memo on rejection so the next call retries (transient keychain/network outages recover in-process)', async () => {
    let attempts = 0;
    const lazy = createLazyAuthProvider(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('keychain locked');
      return fakeProvider('tok');
    });

    await expect(lazy.getAccessToken()).rejects.toThrow('keychain locked');
    await expect(lazy.getAccessToken()).resolves.toBe('tok');
    expect(attempts).toBe(2);
  });

  it('invalidate() is a no-op before resolution and forwards after it', async () => {
    const inner = fakeProvider('tok');
    const lazy = createLazyAuthProvider(async () => inner);

    lazy.invalidate();
    expect(inner.invalidations).toBe(0);

    await lazy.getAccessToken();
    lazy.invalidate();
    expect(inner.invalidations).toBe(1);
  });
});
