/**
 * Unit tests for page-agent-repository
 *
 * Tests for pure functions that contain business logic.
 * Database operations are tested via integration tests.
 */

import { describe, it, expect } from 'vitest';
import { calculateNextPosition } from '../page-agent-repository';

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
