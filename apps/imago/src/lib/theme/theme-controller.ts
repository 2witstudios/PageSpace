import {
  preferenceFromCookies,
  serializeThemeCookie,
  type ThemePreference,
} from './theme-preference';

type Update = () => void;

export type ThemeControllerDeps = {
  /** The preference the page was served with. */
  readonly initial: ThemePreference;
  /** Classic's shared cookie domain, when one is configured. */
  readonly domain: string | undefined;
  /** Writes the preference onto the page (DOM and React state). */
  readonly apply: (preference: ThemePreference) => void;
  readonly writeCookie: (cookie: string) => void;
  /** Reads the cookies shared by every tab (`document.cookie`). */
  readonly readCookies: () => string;
  /** Mirrors the preference into classic's next-themes storage. */
  readonly writeStorage: (preference: ThemePreference) => void;
  /** Tells the viewer's other imago tabs that the preference changed. */
  readonly announce: () => void;
  readonly transition: (update: Update) => void;
};

export type ThemeController = {
  readonly select: (preference: ThemePreference) => void;
  /** Catches up with the shared cookie; returns the preference it holds. */
  readonly sync: () => ThemePreference;
};

/**
 * Orders a theme switch's side effects; ThemeProvider injects the real ones.
 * Ported from myimago's theme-controller, writing classic's cookie and
 * storage instead of its own.
 */
export const createThemeController = ({
  initial,
  domain,
  apply,
  writeCookie,
  readCookies,
  writeStorage,
  announce,
  transition,
}: ThemeControllerDeps): ThemeController => {
  let shown = initial;
  // False once a switch could not be saved (cookies blocked): the cookie no
  // longer describes this tab, so it must not overwrite the choice.
  let saved = true;
  const show = (preference: ThemePreference) => {
    shown = preference;
    transition(() => apply(preference));
  };
  return {
    select: (preference) => {
      writeCookie(serializeThemeCookie(preference, { domain }));
      saved = preferenceFromCookies(readCookies()) === preference;
      writeStorage(preference);
      show(preference);
      if (saved) announce();
    },
    // Announcements carry no value: the shared cookie holds the last write,
    // so a delayed announcement can never apply a stale choice, and a tab
    // that missed one (or a switch made in classic) catches up when shown.
    sync: () => {
      if (!saved) return shown;
      const preference = preferenceFromCookies(readCookies());
      if (preference !== shown) show(preference);
      return preference;
    },
  };
};

/** Crossfades a switch with a view transition unless motion is reduced. */
export const createTransition =
  ({
    startViewTransition,
    prefersReducedMotion,
  }: {
    readonly startViewTransition: ((update: Update) => unknown) | undefined;
    readonly prefersReducedMotion: () => boolean;
  }) =>
  (update: Update): void => {
    if (startViewTransition === undefined || prefersReducedMotion()) update();
    else startViewTransition(update);
  };
