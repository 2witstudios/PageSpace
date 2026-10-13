import Link from 'next/link';
import type { ReactNode } from 'react';
import { askImagoClass } from '@/ui/frame/empty-middle/empty-middle-class';
import { notFoundDetailClass, notFoundTitleClass } from '@/ui/frame/not-found/not-found-class';
import { dispatch, transactions } from '@/ui/store/transactions';

export const PAGE_UNAVAILABLE_TITLE = 'This page isn’t available';
export const PAGE_UNAVAILABLE_DETAIL = 'The link points to a page that was moved to trash, or one you don’t have access to.';
export const PAGE_UNAVAILABLE_NOTE = 'While it resolves, the same spot reads “Opening page…”, then the page opens in its drive with chat on the right.';

export type PageUnavailableProps = {
  /** The viewer's Home drive; Browse Files leads into it, and is left out when there is none. */
  readonly homeDriveId: string | null;
};

const linkButtonClass = 'inline-flex h-9 items-center rounded-lg px-3.5 text-sm font-medium no-underline';

/**
 * The middle a /p/ link shows when it cannot resolve to a page the viewer may open: a trashed page,
 * or one they may not see. It names neither case, and draws no Imago column beside it.
 */
export function renderPageUnavailable({ homeDriveId }: PageUnavailableProps): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center p-10" data-page-unavailable="">
      <div className="flex w-full max-w-[440px] flex-col items-center gap-3.5 text-center">
        <h1 className={notFoundTitleClass}>{PAGE_UNAVAILABLE_TITLE}</h1>
        <p className={`${notFoundDetailClass} leading-relaxed`}>{PAGE_UNAVAILABLE_DETAIL}</p>
        <div className="mt-1.5 flex gap-2">
          <Link href="/" prefetch={true} className={`${linkButtonClass} bg-accent text-white`}>
            Back to Chat
          </Link>
          {homeDriveId === null ? null : (
            <Link
              href={`/${encodeURIComponent(homeDriveId)}/files`}
              prefetch={true}
              className={`${linkButtonClass} border border-accent text-accent`}
            >
              Browse Files
            </Link>
          )}
        </div>
        <button type="button" className={askImagoClass} onClick={() => dispatch(transactions.expandImago, undefined)}>
          Ask Imago
        </button>
        <div className={`${notFoundDetailClass} mt-6 flex w-full items-center gap-2.5 rounded-xl border border-dashed border-accent/40 px-3.5 py-2.5 text-left text-xs`}>
          <span className="size-3.5 shrink-0 rounded-full border-2 border-accent/30 border-t-accent" aria-hidden="true" />
          <span>{PAGE_UNAVAILABLE_NOTE}</span>
        </div>
      </div>
    </div>
  );
}
