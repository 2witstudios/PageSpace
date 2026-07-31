/**
 * The global console's roster-first grouping — a pure decision, kept out of
 * the component. Groups are the UNION of the roster (every drive the user can
 * work in) and any drive a session names that the roster omits, so a drive
 * with zero live sessions still gets a group (and its spawn affordance), and
 * a session never disappears just because the roster doesn't (yet) list its
 * drive.
 */
import { describe, it, expect } from 'vitest';

import { buildSessionGroups, ASSISTANT_GROUP_KEY } from '../session-groups';

const session = (sessionId: string, driveId: string | null) => ({ sessionId, driveId });
const drive = (driveId: string, driveName: string) => ({ driveId, driveName });

describe('buildSessionGroups', () => {
  it('renders every roster drive as a group, even with zero sessions', () => {
    const groups = buildSessionGroups([], {
      assistant: false,
      drives: [drive('drive-1', 'Alpha'), drive('drive-2', 'Beta')],
    });
    expect(groups.map((group) => group.driveId)).toEqual(['drive-1', 'drive-2']);
    expect(groups.every((group) => group.sessions.length === 0)).toBe(true);
  });

  it('puts the Assistant group first, then roster drives name-ascending', () => {
    const groups = buildSessionGroups([], {
      assistant: true,
      drives: [drive('drive-2', 'Beta'), drive('drive-1', 'Alpha')],
    });
    expect(groups.map((group) => group.driveId)).toEqual([ASSISTANT_GROUP_KEY, 'drive-1', 'drive-2']);
    expect(groups.map((group) => group.driveName)).toEqual(['Assistant', 'Alpha', 'Beta']);
  });

  it('merges a roster drive with its sessions — union, not a duplicate group', () => {
    const groups = buildSessionGroups([session('s1', 'drive-1'), session('s2', 'drive-1')], {
      assistant: false,
      drives: [drive('drive-1', 'Alpha')],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions.map((entry) => entry.sessionId)).toEqual(['s1', 's2']);
  });

  it('surfaces a session in a drive the roster omits, ordered last as an orphan', () => {
    const groups = buildSessionGroups([session('s1', 'drive-1'), session('s2', 'drive-orphan')], {
      assistant: false,
      drives: [drive('drive-1', 'Alpha')],
    });
    expect(groups.map((group) => group.driveId)).toEqual(['drive-1', 'drive-orphan']);
    expect(groups[1].driveName).toBeNull();
    expect(groups[1].sessions.map((entry) => entry.sessionId)).toEqual(['s2']);
  });

  it('omits the Assistant group when not requested and no assistant session exists', () => {
    const groups = buildSessionGroups([session('s1', 'drive-1')], {
      assistant: false,
      drives: [drive('drive-1', 'Alpha')],
    });
    expect(groups.map((group) => group.driveId)).toEqual(['drive-1']);
  });

  it('keeps the Assistant group when a session already exists there, even if not requested', () => {
    const groups = buildSessionGroups([session('s1', null)], {
      assistant: false,
      drives: [],
    });
    expect(groups.map((group) => group.driveId)).toEqual([ASSISTANT_GROUP_KEY]);
    expect(groups[0].sessions.map((entry) => entry.sessionId)).toEqual(['s1']);
  });

  it('breaks a roster name tie on driveId', () => {
    const groups = buildSessionGroups([], {
      assistant: false,
      drives: [drive('drive-b', 'Same'), drive('drive-a', 'Same')],
    });
    expect(groups.map((group) => group.driveId)).toEqual(['drive-a', 'drive-b']);
  });
});
