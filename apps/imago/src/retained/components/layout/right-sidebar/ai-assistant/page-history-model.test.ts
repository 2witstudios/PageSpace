import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  actorOf,
  aiViaOf,
  canUndoNow,
  filterVersions,
  groupVersions,
  retentionLabelOf,
  rollbackToPointCount,
  rolledBackIds,
  timeLabelOf,
  verbOf,
  type HistoryVersion,
} from './page-history-model';
import type { ActivityActionPreview } from '@/retained/types/activity-actions';

const NOW = new Date(2026, 9, 12, 12, 0, 0);

const version = (overrides: Partial<HistoryVersion>): HistoryVersion => ({
  id: 'a1',
  timestamp: new Date(2026, 9, 12, 10, 18).toISOString(),
  userId: 'u1',
  actorEmail: 'dana@example.com',
  actorDisplayName: 'Dana',
  operation: 'updated',
  resourceTitle: 'Q4 Launch Plan',
  isAiGenerated: false,
  aiProvider: null,
  changeGroupType: 'user',
  updatedFields: null,
  rollbackFromActivityId: null,
  canRollback: true,
  ...overrides,
});

const preview = (overrides: Partial<ActivityActionPreview>): ActivityActionPreview => ({
  action: 'rollback',
  canExecute: true,
  warnings: [],
  hasConflict: false,
  conflictFields: [],
  requiresForce: false,
  isNoOp: false,
  currentValues: null,
  targetValues: null,
  changes: [],
  affectedResources: [],
  ...overrides,
});

describe('page history model', () => {
  test('verbOf and actorOf', () => {
    assert({
      given: 'an updated page row by a named user',
      should: 'read as "updated the page" from the display name',
      actual: [verbOf(version({})), actorOf(version({}))],
      expected: ['updated the page', 'Dana'],
    });
  });

  test('actorOf falls back to the email, then to Imago for AI rows', () => {
    assert({
      given: 'rows without a display name',
      should: 'use the actor email, or the Imago name for AI rows',
      actual: [
        actorOf(version({ actorDisplayName: null })),
        actorOf(version({ actorDisplayName: null, actorEmail: '', isAiGenerated: true })),
      ],
      expected: ['dana@example.com', 'Imago'],
    });
  });

  test('aiViaOf', () => {
    assert({
      given: 'an AI row from an automation group and one from a user request',
      should: 'label automation as automation and everything else as asked by you',
      actual: [
        aiViaOf(version({ isAiGenerated: true, changeGroupType: 'automation' })),
        aiViaOf(version({ isAiGenerated: true, changeGroupType: 'ai' })),
      ],
      expected: ['automation', 'asked by you'],
    });
  });

  test('rolledBackIds', () => {
    assert({
      given: 'a rollback row that points back at an earlier activity',
      should: 'mark that earlier activity as rolled back',
      actual: [...rolledBackIds([version({ id: 'r1', rollbackFromActivityId: 'a0' }), version({ id: 'a0' })])],
      expected: ['a0'],
    });
  });

  test('filterVersions matches actor, verb, summary and title, and keeps everything for an empty query', () => {
    const rows = [
      version({ id: 'x', actorDisplayName: 'Dana', updatedFields: ['title'] }),
      version({ id: 'y', actorDisplayName: 'Sam', operation: 'trashed', resourceTitle: 'Pricing Model' }),
    ];
    assert({
      given: 'a search query',
      should: 'match case-insensitively across the row text, and keep all rows for an empty query',
      actual: [
        filterVersions(rows, '').map((row) => row.id),
        filterVersions(rows, 'SAM').map((row) => row.id),
        filterVersions(rows, 'trashed').map((row) => row.id),
        filterVersions(rows, 'changed title').map((row) => row.id),
        filterVersions(rows, 'pricing').map((row) => row.id),
      ],
      expected: [['x', 'y'], ['y'], ['y'], ['x'], ['y']],
    });
  });

  test('groupVersions splits Today, Yesterday and dated rows, keeping order', () => {
    const rows = [
      version({ id: 't', timestamp: new Date(2026, 9, 12, 9, 41).toISOString() }),
      version({ id: 'y', timestamp: new Date(2026, 9, 11, 16, 12).toISOString() }),
      version({ id: 'd', timestamp: new Date(2026, 9, 9, 14, 30).toISOString() }),
    ];
    assert({
      given: 'rows from today, yesterday and an earlier day',
      should: 'group them under Today, Yesterday and the short date',
      actual: groupVersions(rows, NOW).map((group) => [group.label, group.items.map((row) => row.id)]),
      expected: [['Today', ['t']], ['Yesterday', ['y']], ['Oct 9', ['d']]],
    });
  });

  test('timeLabelOf shows the clock today and the weekday for older rows', () => {
    assert({
      given: 'a row from today and one from yesterday',
      should: 'show only the time for today and the weekday with it otherwise',
      actual: [
        timeLabelOf(version({ timestamp: new Date(2026, 9, 12, 10, 18).toISOString() }), NOW),
        timeLabelOf(version({ timestamp: new Date(2026, 9, 11, 16, 12).toISOString() }), NOW),
      ],
      expected: ['10:18 AM', 'Sun 4:12 PM'],
    });
  });

  test('retentionLabelOf reads -1 as unlimited', () => {
    assert({
      given: 'a 30-day retention and the unlimited sentinel',
      should: 'say Last 30 days, and Unlimited history for -1',
      actual: [retentionLabelOf(30), retentionLabelOf(-1)],
      expected: ['Last 30 days', 'Unlimited history'],
    });
  });

  test('canUndoNow mirrors the confirm dialog: runnable, or forced when a force is required', () => {
    assert({
      given: 'no preview, a runnable preview, a no-op, and a force-required preview',
      should: 'allow undo only when it can run, or when forced for a force-required preview',
      actual: [
        canUndoNow(null, false),
        canUndoNow(preview({}), false),
        canUndoNow(preview({ isNoOp: true }), false),
        canUndoNow(preview({ canExecute: false, requiresForce: true }), false),
        canUndoNow(preview({ canExecute: false, requiresForce: true }), true),
      ],
      expected: [false, true, false, false, true],
    });
  });

  test('rollbackToPointCount counts what the force choice lets through', () => {
    const affected = [
      { preview: preview({}) },
      { preview: preview({ canExecute: false, requiresForce: true }) },
      { preview: preview({ canExecute: false }) },
    ];
    assert({
      given: 'three affected activities, one of which needs force',
      should: 'count the runnable ones, plus the forced one once force is on',
      actual: [rollbackToPointCount(affected, false), rollbackToPointCount(affected, true)],
      expected: [1, 2],
    });
  });
});
