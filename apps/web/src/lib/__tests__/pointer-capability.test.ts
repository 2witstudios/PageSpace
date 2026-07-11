import { describe, it, expect, afterEach, vi } from 'vitest';

import { detectCoarsePointer, POINTER_CAPABILITY_SCRIPT } from '../pointer-capability';

/** Real-world user-agent strings, verbatim. */
const UA = {
  /** iPadOS with `preferredContentMode: 'recommended'` — reports as a Mac. */
  desktopClassIPad:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  /** iPad Safari in mobile content mode. */
  mobileIPad:
    'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  iPhone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  /** Genuine macOS — UA is indistinguishable from a desktop-class iPad. */
  macOS:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

interface DeviceShape {
  coarse: boolean;
  maxTouchPoints: number;
  userAgent: string;
  capacitorNative?: boolean;
}

function stubDevice({ coarse, maxTouchPoints, userAgent, capacitorNative }: DeviceShape) {
  vi.stubGlobal('window', {
    matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' && coarse }),
    ...(capacitorNative === undefined
      ? {}
      : { Capacitor: { isNativePlatform: () => capacitorNative } }),
  });
  vi.stubGlobal('navigator', { maxTouchPoints, userAgent });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detectCoarsePointer', () => {
  it('returns false during SSR, when there is no window', () => {
    vi.stubGlobal('window', undefined);
    expect(detectCoarsePointer()).toBe(false);
  });

  it('detects the Capacitor native shell even when it reports a fine pointer', () => {
    // The iOS app runs desktop-class by default: pointer is `fine`, hover is `hover`.
    stubDevice({
      coarse: false,
      maxTouchPoints: 5,
      userAgent: UA.desktopClassIPad,
      capacitorNative: true,
    });
    expect(detectCoarsePointer()).toBe(true);
  });

  it('does not treat a non-native Capacitor shim as touch on desktop', () => {
    stubDevice({
      coarse: false,
      maxTouchPoints: 0,
      userAgent: UA.macOS,
      capacitorNative: false,
    });
    expect(detectCoarsePointer()).toBe(false);
  });

  it('detects a plain coarse pointer (iPhone)', () => {
    stubDevice({ coarse: true, maxTouchPoints: 5, userAgent: UA.iPhone });
    expect(detectCoarsePointer()).toBe(true);
  });

  it('detects an iPad in mobile content mode via the coarse-pointer query', () => {
    stubDevice({ coarse: true, maxTouchPoints: 5, userAgent: UA.mobileIPad });
    expect(detectCoarsePointer()).toBe(true);
  });

  it('detects a desktop-class iPad in Safari — the case every media query misses', () => {
    // Reports `pointer: fine` and a Macintosh UA. maxTouchPoints is the only tell.
    stubDevice({ coarse: false, maxTouchPoints: 5, userAgent: UA.desktopClassIPad });
    expect(detectCoarsePointer()).toBe(true);
  });

  it('returns false on real macOS, which has the same UA but no touch points', () => {
    stubDevice({ coarse: false, maxTouchPoints: 0, userAgent: UA.macOS });
    expect(detectCoarsePointer()).toBe(false);
  });

  it('returns false on a touchscreen Windows laptop, which must keep hover behaviour', () => {
    // Deliberately out of scope: a fine pointer is present, so hover works.
    stubDevice({ coarse: false, maxTouchPoints: 10, userAgent: UA.windows });
    expect(detectCoarsePointer()).toBe(false);
  });

  it('tolerates a missing matchMedia', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { maxTouchPoints: 0, userAgent: UA.macOS });
    expect(detectCoarsePointer()).toBe(false);
  });
});

describe('POINTER_CAPABILITY_SCRIPT', () => {
  const evalScript = (device: DeviceShape) => {
    const html: Record<string, string> = {};
    const win = {
      Capacitor:
        device.capacitorNative === undefined
          ? undefined
          : { isNativePlatform: () => device.capacitorNative },
      matchMedia: (query: string) => ({
        matches: query === '(pointer: coarse)' && device.coarse,
      }),
    };
    const nav = { maxTouchPoints: device.maxTouchPoints, userAgent: device.userAgent };
    const doc = {
      documentElement: {
        setAttribute: (name: string, value: string) => {
          html[name] = value;
        },
      },
    };
    new Function('window', 'navigator', 'document', POINTER_CAPABILITY_SCRIPT)(win, nav, doc);
    return html;
  };

  it('stamps data-pointer="coarse" on a desktop-class iPad', () => {
    expect(evalScript({ coarse: false, maxTouchPoints: 5, userAgent: UA.desktopClassIPad })).toEqual(
      { 'data-pointer': 'coarse' },
    );
  });

  it('stamps nothing on real macOS — desktop markup is untouched', () => {
    expect(evalScript({ coarse: false, maxTouchPoints: 0, userAgent: UA.macOS })).toEqual({});
  });

  it('agrees with detectCoarsePointer on the iPhone', () => {
    expect(evalScript({ coarse: true, maxTouchPoints: 5, userAgent: UA.iPhone })).toEqual({
      'data-pointer': 'coarse',
    });
  });
});
