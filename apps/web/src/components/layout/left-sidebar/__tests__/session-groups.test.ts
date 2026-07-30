/**
 * The global console's drive grouping — a pure decision, kept out of the
 * component. The property worth pinning: the ASSISTANT group is
 * deterministically first because it is the user's own, not because a seeded
 * Map entry happened to be inserted before the fetch results.
 */
import { describe, it, expect } from 'vitest';

import { groupSessionsByDrive, ASSISTANT_GROUP_KEY } from '../session-groups';

const session = (sessionId: string, driveId: string | null) => ({ sessionId, driveId });

describe('groupSessionsByDrive', () => {
  it('puts the Assistant group first regardless of fetch order', () => {
    const groups = groupSessionsByDrive(
      [session('s1', 'drive-1'), session('s2', null), session('s3', 'drive-2')],
      { seedEmptyAssistantGroup: false },
    );
    expect(groups.map((group) => group.driveId)).toEqual([ASSISTANT_GROUP_KEY, 'drive-1', 'drive-2']);
  });

  it("keeps the server's listing order within each group, and between drives", () => {
    const groups = groupSessionsByDrive(
      [session('s1', 'drive-2'), session('s2', 'drive-1'), session('s3', 'drive-2')],
      { seedEmptyAssistantGroup: false },
    );
    expect(groups.map((group) => group.driveId)).toEqual(['drive-2', 'drive-1']);
    expect(groups[0].sessions.map((entry) => entry.sessionId)).toEqual(['s1', 's3']);
  });

  it('seeds an empty Assistant group when asked — the affordance to start one IS the group', () => {
    const groups = groupSessionsByDrive([session('s1', 'drive-1')], { seedEmptyAssistantGroup: true });
    expect(groups.map((group) => group.driveId)).toEqual([ASSISTANT_GROUP_KEY, 'drive-1']);
    expect(groups[0].sessions).toEqual([]);
  });

  it('shows no Assistant group when there are no assistant sessions and no seed', () => {
    const groups = groupSessionsByDrive([session('s1', 'drive-1')], { seedEmptyAssistantGroup: false });
    expect(groups.map((group) => group.driveId)).toEqual(['drive-1']);
  });

  it('an empty listing with the seed still yields exactly the Assistant group', () => {
    const groups = groupSessionsByDrive([], { seedEmptyAssistantGroup: true });
    expect(groups).toEqual([{ driveId: ASSISTANT_GROUP_KEY, sessions: [] }]);
  });
});
