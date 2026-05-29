import { describe, it, expect } from 'vitest';
import {
  addTaskVerbTools,
  isStringArray,
  TASK_VERB_TOOLS,
  TRIGGER_TOOL,
} from '../lib/task-verb-tools';

describe('addTaskVerbTools', () => {
  it('adds the three verbs when update_task is present', () => {
    const result = addTaskVerbTools([TRIGGER_TOOL]);
    expect(result).toEqual([
      'update_task',
      'create_task',
      'delete_task',
      'reorder_task',
    ]);
  });

  it('is a no-op when the verbs are already present', () => {
    const input = ['update_task', 'create_task', 'delete_task', 'reorder_task'];
    const result = addTaskVerbTools(input);
    expect(result).toEqual(input);
  });

  it('is a no-op when update_task is absent', () => {
    const input = ['read_page', 'search', 'create_page'];
    const result = addTaskVerbTools(input);
    expect(result).toEqual(input);
  });

  it('preserves other tools and their order, appending only missing verbs', () => {
    const input = ['read_page', 'update_task', 'create_task', 'search'];
    const result = addTaskVerbTools(input);
    expect(result).toEqual([
      'read_page',
      'update_task',
      'create_task',
      'search',
      'delete_task',
      'reorder_task',
    ]);
  });

  it('is idempotent across repeated application', () => {
    const once = addTaskVerbTools([TRIGGER_TOOL]);
    const twice = addTaskVerbTools(once);
    expect(twice).toEqual(once);
  });

  it('leaves an empty allowlist untouched', () => {
    expect(addTaskVerbTools([])).toEqual([]);
  });

  it('exposes the expected verb tool names', () => {
    expect(TASK_VERB_TOOLS).toEqual(['create_task', 'delete_task', 'reorder_task']);
  });
});

describe('isStringArray', () => {
  it('accepts an array of strings', () => {
    expect(isStringArray(['update_task'])).toBe(true);
    expect(isStringArray([])).toBe(true);
  });

  it('rejects null, non-arrays, and arrays with non-string entries', () => {
    expect(isStringArray(null)).toBe(false);
    expect(isStringArray('update_task')).toBe(false);
    expect(isStringArray({ 0: 'update_task' })).toBe(false);
    expect(isStringArray(['update_task', 42])).toBe(false);
  });
});
