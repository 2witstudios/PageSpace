'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import useSWR from 'swr';
import { dispatch, transactions } from '../../store/transactions';
import { handoffFor } from './handoff';
import { renderHandoff } from './classic-handoff.render';

export type ClassicHandoffProps = {
  readonly driveId: string;
  readonly pageId: string;
  /** The view of any page imago draws itself. */
  readonly children: ReactNode;
};

/**
 * A page of the Files section imago has no view for opens as a card that
 * hands it off: to classic, and for an agent to the chat. It sits behind
 * PageObject's gate and reads the gate's answer from SWR's cache (the same
 * key), so the page is asked for once.
 *
 * Chat with this agent goes through the chat header's own selectAgent, so the
 * chat pane's access check (and its fall back to Imago) applies, then moves to
 * the drive's chat.
 */
export function ClassicHandoff({ driveId, pageId, children }: ClassicHandoffProps): ReactNode {
  const router = useRouter();
  const { data } = useSWR<unknown>(`/api/pages/${encodeURIComponent(pageId)}`);
  const handoff = handoffFor(data, driveId, pageId);
  if (handoff === null) return children;
  const { agent, ...card } = handoff;
  return renderHandoff({
    ...card,
    chat:
      agent === null
        ? null
        : () => {
            dispatch(transactions.selectAgent, agent);
            router.push(`/${encodeURIComponent(driveId)}`);
          },
  });
}
