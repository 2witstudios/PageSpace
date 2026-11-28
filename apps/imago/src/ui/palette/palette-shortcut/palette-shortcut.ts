/** The parts of a keydown the shortcut reads. */
export type ShortcutKey = Pick<
  KeyboardEvent,
  'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing'
>;

/**
 * ⌘K on Apple platforms, Ctrl-K elsewhere, and nothing else: on a Mac Ctrl-K
 * is the text fields' delete-to-end-of-line, so the composer keeps it. A key
 * pressed while an input method is composing belongs to the composition.
 */
export const isPaletteShortcut = (event: ShortcutKey, apple: boolean): boolean => {
  if (event.isComposing || event.altKey || event.key.toLowerCase() !== 'k') return false;
  return apple
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey && !event.shiftKey;
};

/** Whether the browser runs on a Mac, iPad or iPhone, where the modifier is ⌘. */
export const isApplePlatform = ({ platform, userAgent }: Pick<Navigator, 'platform' | 'userAgent'>): boolean =>
  /mac|iphone|ipad|ipod/i.test(platform === '' ? userAgent : platform);
