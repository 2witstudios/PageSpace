import Link from 'next/link';
import type { ReactNode } from 'react';
import { notFoundClass, notFoundDetailClass, notFoundLinkClass, notFoundTitleClass } from './not-found-class';

export type NotFoundRenderProps = {
  readonly title: string;
  readonly detail: string;
  /** The viewer's Home drive, basePath-relative; null before it exists. */
  readonly homeHref: string | null;
  /** The link's words when it leads somewhere other than Home, e.g. back to the section's list. */
  readonly linkLabel?: string;
};

/**
 * The object an address that names nothing the viewer can open renders in
 * the object column: the shell stays, and the way back is one link. It never
 * says whether the thing exists, only that it cannot be opened.
 */
export function renderNotFound({
  title,
  detail,
  homeHref,
  linkLabel = 'Go to your Home drive',
}: NotFoundRenderProps): ReactNode {
  return (
    <div className={notFoundClass} data-not-found="">
      <h2 className={notFoundTitleClass}>{title}</h2>
      <p className={notFoundDetailClass}>{detail}</p>
      {homeHref === null ? null : (
        <Link href={homeHref} prefetch={true} className={notFoundLinkClass}>
          {linkLabel}
        </Link>
      )}
    </div>
  );
}

/** The drive form, shared by the server's drive gate and the shell. */
export const DRIVE_NOT_FOUND = {
  title: 'Drive not found',
  detail: 'It does not exist, or you do not have access to it.',
} as const;

const NO_ACCESS = 'It does not exist, or you do not have access to it.';

/** The forms an unknown id inside a drive renders under, per section's object. */
export const PAGE_NOT_FOUND = { title: 'Page not found', detail: NO_ACCESS } as const;
export const CHANNEL_NOT_FOUND = { title: 'Channel not found', detail: NO_ACCESS } as const;
export const TASK_LIST_NOT_FOUND = { title: 'Task list not found', detail: NO_ACCESS } as const;
export const CONVERSATION_NOT_FOUND = {
  title: 'Conversation not found',
  detail: 'It does not exist, or you are not part of it.',
} as const;
