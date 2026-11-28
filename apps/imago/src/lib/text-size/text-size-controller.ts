import { serializeTextSizeCookie, textSizeFromCookies, type TextSize } from './text-size-preference';

export type TextSizeControllerDeps = {
  /** The size the page was served with. */
  readonly initial: TextSize;
  /** The shared cookie domain, when one is configured. */
  readonly domain: string | undefined;
  /** Writes the size onto the page (DOM and React state). */
  readonly apply: (size: TextSize) => void;
  readonly writeCookie: (cookie: string) => void;
  /** Reads the cookies shared by every tab (`document.cookie`). */
  readonly readCookies: () => string;
  /** Tells the viewer's other imago tabs that the size changed. */
  readonly announce: () => void;
};

export type TextSizeController = {
  readonly select: (size: TextSize) => void;
  /** Catches up with the shared cookie; returns the size it holds. */
  readonly sync: () => TextSize;
};

/**
 * Orders a text-size choice's side effects, as createThemeController orders a
 * theme switch's; TextSizeProvider injects the real ones.
 */
export const createTextSizeController = ({
  initial,
  domain,
  apply,
  writeCookie,
  readCookies,
  announce,
}: TextSizeControllerDeps): TextSizeController => {
  let shown = initial;
  // False once a choice could not be saved (cookies blocked): the cookie no
  // longer describes this tab, so it must not overwrite the choice.
  let saved = true;
  const show = (size: TextSize) => {
    shown = size;
    apply(size);
  };
  return {
    select: (size) => {
      writeCookie(serializeTextSizeCookie(size, { domain }));
      saved = textSizeFromCookies(readCookies()) === size;
      show(size);
      if (saved) announce();
    },
    // Announcements carry no value: the shared cookie holds the last write,
    // so a delayed announcement can never apply a stale choice, and a tab
    // that missed one catches up when shown.
    sync: () => {
      if (!saved) return shown;
      const size = textSizeFromCookies(readCookies());
      if (size !== shown) show(size);
      return size;
    },
  };
};
