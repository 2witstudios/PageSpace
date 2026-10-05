import { cn } from '../../cn';

/** The thread's column inside the object pane. */
export const threadClass = 'flex w-full flex-col px-6 py-4';

/** `# launch`: the glyph and the channel's name. */
export const threadTitleClass = 'flex items-center gap-2 pb-2 text-md font-semibold text-ink';

/** Why there are no posts: loading, failed or empty. */
export const threadNoteClass = 'px-2 py-4 text-sm text-ink-muted';

/** "Load earlier posts", centred above the oldest post. */
export const olderClass = 'self-center';

/* PageSpace's channel rows: flat on the canvas, no bubble. A post that
   mentions the viewer is the one that is filled. Every row carries the edge,
   clear unless it is a mention, so the mention's accent never nudges its
   face out of line. */
export const postClass = ({ lead, mentioned }: { readonly lead: boolean; readonly mentioned: boolean }): string =>
  cn(
    'group flex gap-3 border-l-2 px-2 py-1',
    lead && 'mt-3',
    mentioned ? 'rounded-r-lg border-l-accent bg-accent-soft' : 'rounded-lg border-l-transparent hover:bg-surface-overlay',
  );

export const postAuthorClass = 'text-sm font-semibold text-ink';

export const postTimeClass = 'text-xs text-ink-faint tabular-nums';

/* The gutter holds the lead's face, or a follow-up's time on hover, so
   every body starts on the same line. */
export const postFollowTimeClass =
  'w-avatar-sm flex-none pt-1 text-center text-2xs text-ink-faint tabular-nums opacity-0 group-focus-within:opacity-100 group-hover:opacity-100';

/** Plain text that keeps the author's line breaks. */
export const postBodyClass = 'text-sm leading-normal break-words whitespace-pre-wrap text-ink';

export const editedClass = 'text-xs text-ink-faint';

/** A mention reads as a name in accent ink; the viewer's own is tinted too. */
export const mentionClass = (you: boolean): string =>
  you ? 'rounded-sm bg-accent-soft px-1 font-medium text-accent' : 'font-medium text-accent';

export const reactionsClass = 'mt-1 flex flex-wrap gap-1';

/** A read-only reaction chip; the viewer's takes the accent tint. */
export const reactionClass = (mine: boolean): string =>
  cn(
    'inline-flex items-center gap-1 rounded-round border px-2 text-xs',
    mine ? 'border-accent bg-accent-soft text-ink' : 'border-hairline text-ink-muted',
  );

/* A day is labelled in the middle of a hairline; where unread begins the
   line turns accent and "New" sits at its end. */
export const dividerClass = 'my-3 flex items-center gap-3 text-xs font-medium';

export const dividerLineClass = (unread: boolean): string => cn('h-px flex-1', unread ? 'bg-accent' : 'bg-hairline');

export const dividerLabelClass = 'text-ink-faint';

export const dividerNewClass = 'text-accent';
