import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  countTreePages,
  deleteConsequences,
  isExactNameConfirmed,
  latestFinishedBackupAt,
  safetyNetParts,
} from './drive-delete-model';

describe('deleteConsequences', () => {
  test('lists the real counts with singular and plural nouns', () => {
    assert({
      given: 'a drive with 214 pages, 4 people, 1 guest, 3 agents and 1 app',
      should: 'list every consequence with its count',
      actual: deleteConsequences({ pages: 214, people: 4, guests: 1, agents: 3, apps: 1 }),
      expected: [
        'Move all 214 pages and their content to trash',
        'Revoke access for 4 people, 1 guest, 3 agents and 1 app',
        'Stop all AI agents and automations',
      ],
    });
  });

  test('uses singular nouns for a count of one', () => {
    assert({
      given: 'a drive with one page and one person',
      should: 'say page and person, not the plural',
      actual: deleteConsequences({ pages: 1, people: 1, guests: 0, agents: 0, apps: 0 }).slice(0, 2),
      expected: ['Move all 1 page and their content to trash', 'Revoke access for 1 person, 0 guests, 0 agents and 0 apps'],
    });
  });
});

describe('isExactNameConfirmed', () => {
  test('stays false until the typed text is the exact name', () => {
    assert({
      given: 'the drive name Studio',
      should: 'refuse a partial name, a different case and surrounding spaces, and accept only the exact name',
      actual: [
        isExactNameConfirmed('Studio', 'Stud'),
        isExactNameConfirmed('Studio', 'studio'),
        isExactNameConfirmed('Studio', ' Studio '),
        isExactNameConfirmed('Studio', 'Studio'),
      ],
      expected: [false, false, false, true],
    });
  });

  test('never confirms an empty name', () => {
    assert({
      given: 'an empty drive name and an empty field',
      should: 'keep delete disabled',
      actual: isExactNameConfirmed('', ''),
      expected: false,
    });
  });
});

describe('countTreePages', () => {
  test('counts every node in the nested page tree', () => {
    assert({
      given: 'a tree with two roots, one of which has two children',
      should: 'count all four pages',
      actual: countTreePages([
        { id: 'a', children: [{ id: 'b', children: [] }, { id: 'c', children: [] }] },
        { id: 'd', children: [] },
      ]),
      expected: 4,
    });
  });

  test('counts zero for anything that is not a list', () => {
    assert({
      given: 'a response that is not an array',
      should: 'count zero pages',
      actual: countTreePages({ error: 'nope' }),
      expected: 0,
    });
  });
});

describe('latestFinishedBackupAt', () => {
  test('picks the latest ready backup and ignores pending or failed ones', () => {
    assert({
      given: 'a newer pending backup, an older ready one and a later failed one',
      should: 'return the completion time of the older ready backup',
      actual: latestFinishedBackupAt([
        { status: 'pending', completedAt: '2026-10-09T10:00:00.000Z' },
        { status: 'ready', completedAt: '2026-10-06T08:00:00.000Z' },
        { status: 'failed', completedAt: '2026-10-08T08:00:00.000Z' },
      ]),
      expected: '2026-10-06T08:00:00.000Z',
    });
  });

  test('returns null when no backup has finished', () => {
    assert({
      given: 'only a pending backup',
      should: 'return null',
      actual: latestFinishedBackupAt([{ status: 'pending', completedAt: null }]),
      expected: null,
    });
  });
});

describe('safetyNetParts', () => {
  test('names the date of the last finished backup', () => {
    assert({
      given: 'a last finished backup on 6 October',
      should: 'end the line with the date after the Create a backup link',
      actual: safetyNetParts('2026-10-06T08:00:00.000Z').tail.includes('the last one finished Oct 6.'),
      expected: true,
    });
  });
});
