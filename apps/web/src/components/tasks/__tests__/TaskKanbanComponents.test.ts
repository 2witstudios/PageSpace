import { describe, it, expect } from 'vitest';
import { STATUS_GROUP_CONFIG, getStatusGroupConfig } from '../TaskKanbanComponents';

describe('getStatusGroupConfig', () => {
  it('returns the matching config for each known group', () => {
    expect(getStatusGroupConfig('todo')).toEqual(STATUS_GROUP_CONFIG.todo);
    expect(getStatusGroupConfig('in_progress')).toEqual(STATUS_GROUP_CONFIG.in_progress);
    expect(getStatusGroupConfig('done')).toEqual(STATUS_GROUP_CONFIG.done);
  });

  it('falls back to the todo config for a group with no seeded status config', () => {
    // Reproduces the crash: a TASK_LIST page whose taskStatusConfigs were never
    // seeded (or a status whose group isn't one of the 3 known keys) previously
    // hit `STATUS_GROUP_CONFIG[undefined].color` -> "Cannot read properties of
    // undefined (reading 'color')".
    expect(getStatusGroupConfig('unknown_group')).toEqual(STATUS_GROUP_CONFIG.todo);
    expect(getStatusGroupConfig(undefined as unknown as string)).toEqual(STATUS_GROUP_CONFIG.todo);
    expect(getStatusGroupConfig('')).toEqual(STATUS_GROUP_CONFIG.todo);
  });
});
