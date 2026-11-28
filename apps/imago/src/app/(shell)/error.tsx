'use client';

import type { ReactNode } from 'react';
import { renderErrorState } from '@/ui/frame/edge-state/edge-state.render';

export type ShellErrorProps = {
  readonly error: Error & { readonly digest?: string };
  /** Next's re-render of the route that threw. */
  readonly reset: () => void;
};

/**
 * What a stage route that threw renders. It sits below the (shell) layout, so
 * the rail, the panes and the chat stay mounted and only the object column
 * changes. The error's message can carry server internals, so it is never
 * drawn; the server logs it under its digest.
 */
export default function ShellError({ reset }: ShellErrorProps): ReactNode {
  return renderErrorState({ title: 'Something went wrong', retry: reset });
}
