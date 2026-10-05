import type { ReactNode } from 'react';
import { ApiError } from '@/api/errors';
import { renderButton } from '../../components/button/button.render';
import { notFoundClass, notFoundDetailClass, notFoundTitleClass } from '../not-found/not-found-class';

/**
 * The one thing a failed request says, whatever the server answered: its
 * text can name internals, so it never reaches the screen.
 */
export const ERROR_DETAIL = 'Something went wrong on the way. Check your connection, then try again.';

export type EmptyStateProps = {
  readonly title: string;
  readonly detail: string;
};

/**
 * A section with nothing in it yet, drawn as the not-found object is:
 * centred where its rows would be, quiet, and saying what will show up.
 */
export function renderEmptyState({ title, detail }: EmptyStateProps): ReactNode {
  return (
    <div className={notFoundClass} data-empty="">
      <h2 className={notFoundTitleClass}>{title}</h2>
      <p className={notFoundDetailClass}>{detail}</p>
    </div>
  );
}

export type ErrorStateProps = {
  /** What could not be loaded, e.g. "Could not load this task list". */
  readonly title: string;
  /** Void action: asks again (SWR's revalidate, or the view's own reload). */
  readonly retry: () => void;
};

/** A request that failed, in place of what it would have drawn, with a way to ask again. */
export function renderErrorState({ title, retry }: ErrorStateProps): ReactNode {
  return (
    <div className={notFoundClass} role="alert" data-error="">
      <h2 className={notFoundTitleClass}>{title}</h2>
      <p className={notFoundDetailClass}>{ERROR_DETAIL}</p>
      {renderButton({ variant: 'secondary', onClick: retry, children: 'Try again' })}
    </div>
  );
}

/**
 * Which edge a failed load is. apps/web answers 404 for an id it does not
 * know and 403 for one the viewer may not open; imago draws both as
 * not-found, so the answer never says whether the thing exists. Anything
 * else (5xx, a bad answer, the network) is an error a retry may fix.
 */
export const edgeOf = (error: unknown): 'not-found' | 'error' =>
  error instanceof ApiError && (error.status === 404 || error.status === 403) ? 'not-found' : 'error';
