/**
 * Unit tests for page-agent-repository
 *
 * Tests for pure functions that contain business logic.
 * Database operations are tested via integration tests.
 */

import { describe, it, expect } from 'vitest';
import { calculateNextPosition, isMachineRef, isMachineRefArray } from '../page-agent-repository';

describe('calculateNextPosition', () => {
  it('should return 1 when there are no siblings', () => {
    const result = calculateNextPosition([]);

    expect(result).toBe(1);
  });

  it('should return next position after highest sibling', () => {
    const siblings = [
      { position: 5 },  // Highest (ordered desc by DB)
      { position: 3 },
      { position: 1 },
    ];

    const result = calculateNextPosition(siblings);

    expect(result).toBe(6);
  });

  it('should handle single sibling', () => {
    const siblings = [{ position: 10 }];

    const result = calculateNextPosition(siblings);

    expect(result).toBe(11);
  });

  it('should handle siblings with position 0', () => {
    const siblings = [{ position: 0 }];

    const result = calculateNextPosition(siblings);

    expect(result).toBe(1);
  });

  it('should handle negative positions (edge case)', () => {
    // While negative positions shouldn't happen, the function should handle it
    const siblings = [{ position: -1 }];

    const result = calculateNextPosition(siblings);

    expect(result).toBe(0);
  });
});

describe('isMachineRef', () => {
  it('accepts { kind: "own" }', () => {
    expect(isMachineRef({ kind: 'own' })).toBe(true);
  });

  it('accepts { kind: "existing", terminalId }', () => {
    expect(isMachineRef({ kind: 'existing', terminalId: 'term_1' })).toBe(true);
  });

  it('rejects "existing" without a terminalId', () => {
    expect(isMachineRef({ kind: 'existing' })).toBe(false);
  });

  it('rejects "existing" with an empty terminalId', () => {
    expect(isMachineRef({ kind: 'existing', terminalId: '' })).toBe(false);
  });

  it('rejects "existing" with a non-string terminalId', () => {
    expect(isMachineRef({ kind: 'existing', terminalId: 123 })).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(isMachineRef({ kind: 'other' })).toBe(false);
  });

  it('rejects non-object values', () => {
    expect(isMachineRef('own')).toBe(false);
    expect(isMachineRef(null)).toBe(false);
    expect(isMachineRef(undefined)).toBe(false);
  });
});

describe('isMachineRefArray', () => {
  it('accepts an empty array', () => {
    expect(isMachineRefArray([])).toBe(true);
  });

  it('accepts an array of valid MachineRefs', () => {
    expect(
      isMachineRefArray([{ kind: 'own' }, { kind: 'existing', terminalId: 'term_1' }])
    ).toBe(true);
  });

  it('rejects an array containing an invalid entry', () => {
    expect(isMachineRefArray([{ kind: 'own' }, { kind: 'existing' }])).toBe(false);
  });

  it('rejects non-array values', () => {
    expect(isMachineRefArray({ kind: 'own' })).toBe(false);
    expect(isMachineRefArray(null)).toBe(false);
    expect(isMachineRefArray(undefined)).toBe(false);
  });
});
