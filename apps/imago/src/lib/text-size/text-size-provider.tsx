'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { applyTextSize } from './apply-text-size';
import { createTextSizeController, type TextSizeController } from './text-size-controller';
import { parseTextSize, type TextSize } from './text-size-preference';

type TextSizeContextValue = {
  readonly size: TextSize;
  readonly selectSize: (size: TextSize) => void;
};

const TextSizeContext = createContext<TextSizeContextValue | null>(null);

const CHANNEL_NAME = 'imago-text-size';

export type TextSizeProviderProps = {
  /** The request's cookie size, parsed by the root layout. */
  readonly initialSize: TextSize;
  readonly children: ReactNode;
};

/**
 * Request-scoped text-size state, as ThemeProvider holds the theme: seeded from
 * the request cookie, so server HTML and the first client render agree. A
 * choice writes the cookie, sets <html data-text-size> in place, and reaches
 * other imago tabs through a BroadcastChannel.
 */
export function TextSizeProvider({ initialSize, children }: TextSizeProviderProps) {
  const [size, setSize] = useState(initialSize);
  const controller = useRef<TextSizeController | null>(null);

  useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    const next = createTextSizeController({
      // What the page shows now: the server rendered it from the cookie.
      initial: parseTextSize(document.documentElement.dataset.textSize),
      // The same build-time cookie domain the theme cookie uses.
      domain: process.env.NEXT_PUBLIC_COOKIE_DOMAIN,
      apply: (chosen) => {
        applyTextSize(document.documentElement, chosen);
        setSize(chosen);
      },
      writeCookie: (cookie) => {
        // A plain, non-secret preference cookie; the server re-validates it.
        document.cookie = cookie;
      },
      readCookies: () => document.cookie,
      announce: () => channel.postMessage(null),
    });
    const sync = () => next.sync();
    // A hidden, frozen or back/forward-cached tab misses announcements; it
    // catches up from the cookie when shown again.
    const syncWhenVisible = () => {
      if (document.visibilityState === 'visible') sync();
    };
    channel.addEventListener('message', sync);
    document.addEventListener('visibilitychange', syncWhenVisible);
    addEventListener('pageshow', sync);
    controller.current = next;
    return () => {
      controller.current = null;
      channel.close();
      document.removeEventListener('visibilitychange', syncWhenVisible);
      removeEventListener('pageshow', sync);
    };
  }, []);

  const selectSize = useCallback((chosen: TextSize) => {
    controller.current?.select(chosen);
  }, []);

  const value = useMemo(() => ({ size, selectSize }), [size, selectSize]);

  return <TextSizeContext value={value}>{children}</TextSizeContext>;
}

export const useTextSize = (): TextSizeContextValue => {
  const value = useContext(TextSizeContext);
  if (value === null) throw new Error('useTextSize must be used inside TextSizeProvider');
  return value;
};
