import type { ChatDensity } from '../../frame/stage/stage';
import { cn } from '../../cn';

/**
 * One chat column for every stage. Density, not a second component, is what
 * separates the fluid chat from the 350px one beside an object (myimago ADR
 * 0029); the dense one keeps a hairline from the object.
 */
export const chatPaneClass = (density: ChatDensity): string =>
  cn('flex h-full w-full min-w-0 flex-col', density === 'dense' && 'border-l border-hairline');

const threads: Readonly<Record<ChatDensity, string>> = {
  roomy: 'mx-auto flex w-full max-w-thread flex-col gap-4 px-6 py-8',
  dense: 'flex w-full flex-col gap-3 p-4',
};

export const chatThreadClass = (density: ChatDensity): string => threads[density];

/** The thread scrolls; the header and composer stay put. */
export const chatScrollClass = 'min-h-0 flex-1 overflow-y-auto';

/** The header's title: the agent, a slash, then what it answers against. */
export const chatHeaderTitleClass = 'flex min-w-0 items-center gap-2';

export const chatAgentNameClass = 'flex-none font-medium';

export const chatContextLabelClass = 'truncate text-xs font-normal text-ink-muted';

/** The invitation an empty conversation shows, centred in the thread. */
export const chatEmptyClass = 'my-auto text-center text-ink-faint';

/** What went wrong, above the composer. */
export const chatNoticeClass = 'text-sm text-warn';
