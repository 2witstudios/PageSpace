import Link from 'next/link';
import type { ReactNode } from 'react';
import { notFoundClass, notFoundDetailClass, notFoundLinkClass, notFoundTitleClass } from './not-found-class';

export type NotFoundRenderProps = {
  readonly title: string;
  readonly detail: string;
  /** The viewer's Home drive, basePath-relative; null before it exists. */
  readonly homeHref: string | null;
};

/**
 * The object an address that names nothing the viewer can open renders in
 * the object column: the shell stays, and the way back is one link. It never
 * says whether the thing exists, only that it cannot be opened.
 */
export function renderNotFound({ title, detail, homeHref }: NotFoundRenderProps): ReactNode {
  return (
    <div className={notFoundClass} data-not-found="">
      <h2 className={notFoundTitleClass}>{title}</h2>
      <p className={notFoundDetailClass}>{detail}</p>
      {homeHref === null ? null : (
        <Link href={homeHref} prefetch={true} className={notFoundLinkClass}>
          Go to your Home drive
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
