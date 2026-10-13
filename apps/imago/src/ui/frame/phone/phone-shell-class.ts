/** The phone fills the viewport on the page ground; the screen scrolls, the frame never does. */
export const phoneShellClass = 'relative flex h-screen w-full flex-col overflow-hidden bg-background';

export const phoneMainClass = 'flex min-h-0 flex-1 flex-col';

/** The floating "Ask" over the Files tree: a spine-blue pill above the bottom bar. */
export const phoneAskClass =
  'absolute right-4 bottom-phone-ask-bottom z-rail flex h-spine-tile cursor-pointer items-center gap-2 rounded-round border-0 bg-spine pr-4 pl-3 text-sm font-medium text-spine-on shadow-sheet';
