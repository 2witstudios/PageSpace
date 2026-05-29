import { describe, it, expect } from 'vitest';
import {
  addTrashVerbTools,
  TRASH_VERB_TOOLS,
  RESTORE_VERB_TOOLS,
  TRASH_TRIGGER,
  RESTORE_TRIGGER,
} from '../lib/trash-verb-tools';

describe('addTrashVerbTools', () => {
  it('adds the trash verbs when trash is present', () => {
    const result = addTrashVerbTools([TRASH_TRIGGER]);
    expect(result).toEqual(['trash', 'trash_page', 'trash_drive']);
  });

  it('adds the restore verbs when restore is present', () => {
    const result = addTrashVerbTools([RESTORE_TRIGGER]);
    expect(result).toEqual(['restore', 'restore_page', 'restore_drive']);
  });

  it('adds both sets of verbs when trash and restore are present', () => {
    const result = addTrashVerbTools(['trash', 'restore']);
    expect(result).toEqual([
      'trash',
      'restore',
      'trash_page',
      'trash_drive',
      'restore_page',
      'restore_drive',
    ]);
  });

  it('is a no-op when neither trigger is present', () => {
    const input = ['read_page', 'search', 'create_page'];
    const result = addTrashVerbTools(input);
    expect(result).toEqual(input);
  });

  it('is a no-op when the trash verbs are already present', () => {
    const input = ['trash', 'trash_page', 'trash_drive'];
    const result = addTrashVerbTools(input);
    expect(result).toEqual(input);
  });

  it('is a no-op when the restore verbs are already present', () => {
    const input = ['restore', 'restore_page', 'restore_drive'];
    const result = addTrashVerbTools(input);
    expect(result).toEqual(input);
  });

  it('appends only the missing verb for a partially-populated allowlist', () => {
    const input = ['trash', 'trash_page', 'restore', 'restore_drive'];
    const result = addTrashVerbTools(input);
    expect(result).toEqual([
      'trash',
      'trash_page',
      'restore',
      'restore_drive',
      'trash_drive',
      'restore_page',
    ]);
  });

  it('preserves other tools and their order, appending only missing verbs', () => {
    const input = ['read_page', 'trash', 'search', 'restore'];
    const result = addTrashVerbTools(input);
    expect(result).toEqual([
      'read_page',
      'trash',
      'search',
      'restore',
      'trash_page',
      'trash_drive',
      'restore_page',
      'restore_drive',
    ]);
  });

  it('appends verbs to a mixed array containing trash, keeping non-string entries', () => {
    // Mirrors runtime: the allowlist grants trash via Array.includes, so a
    // legacy/mixed array must still receive the verbs without dropping junk.
    const input = ['trash', 123, 'read_page'];
    const result = addTrashVerbTools(input);
    expect(result).toEqual([
      'trash',
      123,
      'read_page',
      'trash_page',
      'trash_drive',
    ]);
  });

  it('is a no-op for a mixed array that contains neither trigger', () => {
    const input = ['read_page', 42, { tool: 'x' }];
    const result = addTrashVerbTools(input);
    expect(result).toEqual(input);
  });

  it('is idempotent across repeated application', () => {
    const once = addTrashVerbTools(['trash', 'restore']);
    const twice = addTrashVerbTools(once);
    expect(twice).toEqual(once);
  });

  it('leaves an empty allowlist untouched', () => {
    expect(addTrashVerbTools([])).toEqual([]);
  });

  it('exposes the expected verb tool names', () => {
    expect(TRASH_VERB_TOOLS).toEqual(['trash_page', 'trash_drive']);
    expect(RESTORE_VERB_TOOLS).toEqual(['restore_page', 'restore_drive']);
  });
});
