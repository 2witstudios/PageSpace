import type { ChatDensity } from '../../frame/stage/stage';
import { cn } from '../../cn';

export type ChatAuthor = 'user' | 'assistant';

const base = 'flex min-w-0 flex-col gap-2 leading-normal text-ink';

const size: Readonly<Record<ChatDensity, string>> = {
  roomy: 'text-base',
  dense: 'text-sm',
};

/* PageSpace's chat (ADR 0029 decision 6): the assistant writes plain prose on
   the canvas, with no bubble; the viewer's message is a quiet accent-soft
   card. Each is inset from the other's side, so the thread still reads as a
   conversation. */
const authors: Readonly<Record<ChatAuthor, Readonly<Record<ChatDensity, string>>>> = {
  user: {
    roomy: 'ml-8 rounded-lg bg-accent-soft p-3',
    dense: 'ml-4 rounded-lg bg-accent-soft px-3 py-2',
  },
  assistant: {
    roomy: 'mr-8',
    dense: 'mr-4',
  },
};

/** Classes for one message. */
export const chatMessageClass = (author: ChatAuthor, density: ChatDensity): string =>
  cn(base, size[density], authors[author][density]);
