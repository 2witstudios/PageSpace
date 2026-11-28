'use client';

// The /dm index's ground: the people the viewer can message, loaded through SWR.

import { renderDmGround, type DmGroundState } from './dm-index.render';
import { useMessageablePeople } from './use-dm-index';

/** The DM ground's people: everyone the viewer can message, from GET /api/users/messageable. */
export function DmGround() {
  const { people, error, retry } = useMessageablePeople();
  const state: DmGroundState =
    people !== undefined
      ? people.length === 0
        ? { status: 'empty' }
        : { status: 'ready', people }
      : error === undefined
        ? { status: 'loading' }
        : { status: 'error', retry };
  return renderDmGround({ people: state });
}
