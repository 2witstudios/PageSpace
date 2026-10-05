'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { applyTheme } from './apply-theme';
import {
  createThemeController,
  createTransition,
  type ThemeController,
} from './theme-controller';
import {
  THEME_STORAGE_KEY,
  parseThemePreference,
  type ThemePreference,
} from './theme-preference';

type ThemeContextValue = {
  readonly preference: ThemePreference;
  readonly selectPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

const CHANNEL_NAME = 'imago-theme';

export type ThemeProviderProps = {
  /** The request's cookie preference, parsed by the root layout. */
  readonly initialPreference: ThemePreference;
  readonly children: ReactNode;
};

/**
 * Request-scoped theme state: seeded from the request cookie, so server HTML
 * and the first client render agree. A switch writes classic's cookie and
 * next-themes storage, sets <html data-theme> in place (crossfaded by a view
 * transition), and reaches other imago tabs through a BroadcastChannel.
 */
export function ThemeProvider({
  initialPreference,
  children,
}: ThemeProviderProps) {
  const [preference, setPreference] = useState(initialPreference);
  const controller = useRef<ThemeController | null>(null);

  useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const next = createThemeController({
      // What the page shows now: the server rendered it from the cookie.
      initial: parseThemePreference(document.documentElement.dataset.theme),
      // Classic's syncThemeToCookie reads the same build-time variable.
      domain: process.env.NEXT_PUBLIC_COOKIE_DOMAIN,
      apply: (chosen) => {
        applyTheme(document.documentElement, chosen);
        // Commit synchronously so the view transition snapshots the
        // switcher's new state too.
        flushSync(() => setPreference(chosen));
      },
      writeCookie: (cookie) => {
        // A plain, non-secret preference cookie; the server re-validates it.
        document.cookie = cookie;
      },
      readCookies: () => document.cookie,
      writeStorage: (chosen) => {
        try {
          localStorage.setItem(THEME_STORAGE_KEY, chosen);
        } catch {
          // Storage unavailable (private mode / blocked): the cookie covers us.
        }
      },
      announce: () => channel.postMessage(null),
      transition: createTransition({
        startViewTransition:
          'startViewTransition' in document
            ? (update) => document.startViewTransition(update)
            : undefined,
        prefersReducedMotion: () => reducedMotion.matches,
      }),
    });
    const sync = () => next.sync();
    // A hidden, frozen or back/forward-cached tab misses announcements and
    // never hears classic; it catches up from the cookie when shown again.
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

  const selectPreference = useCallback((chosen: ThemePreference) => {
    controller.current?.select(chosen);
  }, []);

  const value = useMemo(
    () => ({ preference, selectPreference }),
    [preference, selectPreference],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export const useThemePreference = (): ThemeContextValue => {
  const value = useContext(ThemeContext);
  if (value === null)
    throw new Error('useThemePreference must be used inside ThemeProvider');
  return value;
};
