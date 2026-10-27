import type { ChatDensity } from '../../frame/stage/stage';
import { cn } from '../../cn';

/** The composer floats: no strip or border above it, only space. */
export const composerFormClass = 'flex-none pt-2 pb-4';

/* The column owns the horizontal padding so the composer's edges line up with
   the thread's, which carries the same column and the same padding. */
const shellDensity: Readonly<Record<ChatDensity, string>> = {
  roomy: 'mx-auto w-full max-w-thread px-6',
  dense: 'w-full px-4',
};

/** Classes for the composer's column: centred while the chat is wide. */
export const composerShellClass = (density: ChatDensity): string => shellDensity[density];

/**
 * The composer's entry: PageSpace's floating card, the one shape rounder
 * than the radius ladder, with a soft border and an ambient lift.
 */
export const composerEntryClass =
  'flex flex-col gap-2 rounded-composer border border-border/60 bg-background p-3 shadow-ambient transition-colors duration-120 ease-standard focus-within:border-border-strong';

const fieldBase = 'w-full resize-none border-none bg-transparent text-ink outline-none placeholder:text-ink-faint';

const fieldDensity: Readonly<Record<ChatDensity, string>> = {
  roomy: 'h-composer-field text-base',
  dense: 'h-composer-field-dense text-sm',
};

/** Classes for the textarea itself. */
export const composerFieldClass = (density: ChatDensity): string => cn(fieldBase, fieldDensity[density]);

/** The row under the field; Send (or Stop) sits at its end. */
export const composerActionsClass = 'flex items-center justify-end gap-1';

/** Send and Stop: a 36px circle, accent in light and quiet in dark. */
export const composerSendClass =
  'flex size-send flex-none cursor-pointer items-center justify-center rounded-round bg-send text-send-ink transition-colors duration-120 ease-standard disabled:cursor-default disabled:opacity-50';
