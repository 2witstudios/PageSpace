/* Settings open as an object beside the chat, in the reading column a
   document sits in (myimago's settings view). */
export const settingsClass = 'mx-auto flex w-full max-w-doc flex-col gap-8 px-8 py-6';

export const settingsTitleClass = 'm-0 text-doc-title leading-tight font-bold tracking-doc-title text-ink';

export const settingsSectionClass = 'flex flex-col gap-3';

export const settingsHeadingClass = 'm-0 text-lg font-semibold tracking-snug text-ink';

export const settingsDetailClass = 'm-0 text-sm text-ink-muted';

/** Why a change was refused, under the control it was made with. */
export const settingsNoticeClass = 'm-0 text-xs font-medium text-live';

/* The drive name, edited where it sits: one control shape, as the task fields. */
export const settingsNameInputClass =
  'rounded-md border border-hairline bg-transparent px-3 py-2 text-md text-ink transition-colors duration-120 ease-standard outline-none hover:border-border-strong';

export const settingsNameClass = 'm-0 text-md font-medium text-ink';

export const settingsRowClass = 'flex items-center justify-between gap-4';

/* A switch: a round track with the accent fill when on, and a knob that
   slides across. Focus draws the global accent halo. */
const switchBase =
  'inline-flex h-6 w-10 flex-none cursor-pointer items-center rounded-round px-1 transition-colors duration-120 ease-standard disabled:cursor-default disabled:opacity-60';

export const switchClass = (on: boolean): string => `${switchBase} ${on ? 'bg-accent' : 'bg-border-strong'}`;

const knobBase = 'size-4 rounded-round bg-background shadow-ambient transition-transform duration-120 ease-standard';

export const switchKnobClass = (on: boolean): string => `${knobBase} ${on ? 'translate-x-4' : 'translate-x-0'}`;

export const membersListClass = 'm-0 flex list-none flex-col gap-1 p-0';

export const memberRowClass = 'flex items-center gap-3 rounded-md px-2 py-2';

export const memberTextClass = 'flex min-w-0 flex-1 flex-col';

export const memberNameClass = 'truncate text-sm font-medium text-ink';

export const memberEmailClass = 'truncate text-xs text-ink-muted';

export const settingsLinkClass = 'text-sm font-medium text-accent';

export const accountListClass = 'm-0 flex list-none flex-col gap-2 p-0';

/* The account's ways into classic: one quiet row each. */
export const accountLinkClass =
  'flex items-center gap-3 rounded-md border border-hairline px-4 py-3 text-ink transition-colors duration-120 ease-standard hover:border-border-strong';
