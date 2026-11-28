/**
 * The phone fills the dynamic viewport (100dvh follows iOS Safari's URL bar) on the page ground,
 * inset from the notch and status bar; the screen scrolls, the frame never does.
 */
export const phoneShellClass = 'phone-safe-frame relative flex h-dvh w-full flex-col overflow-hidden bg-background';

export const phoneMainClass = 'flex min-h-0 flex-1 flex-col';

/** With no bottom bar under it (full-screen Imago), the screen clears the home indicator itself. */
export const phoneMainBarlessClass = `${phoneMainClass} phone-safe-bottom`;

/** The floating "Ask" over the Files tree: a spine-blue pill above the bottom bar. */
export const phoneAskClass =
  'phone-safe-ask absolute right-4 z-rail flex h-spine-tile cursor-pointer items-center gap-2 rounded-round border-0 bg-spine pr-4 pl-3 text-sm font-medium text-spine-on shadow-sheet';
