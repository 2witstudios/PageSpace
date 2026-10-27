import { describe, it, expect } from 'vitest';
import {
  normalizeUsageSource,
  USAGE_SOURCE_LABELS,
  USAGE_SOURCES,
  type AIUsageSource,
} from '../usage-source';

describe('normalizeUsageSource', () => {
  it('maps every known source to itself', () => {
    for (const source of USAGE_SOURCES) {
      expect(normalizeUsageSource(source)).toBe(source);
    }
  });

  it('folds unknown strings to "other"', () => {
    expect(normalizeUsageSource('general_chat')).toBe('other');
    expect(normalizeUsageSource('Chat')).toBe('other'); // case-sensitive
    expect(normalizeUsageSource('')).toBe('other');
  });

  it('folds non-string / nullish input to "other"', () => {
    expect(normalizeUsageSource(undefined)).toBe('other');
    expect(normalizeUsageSource(null)).toBe('other');
    expect(normalizeUsageSource(42)).toBe('other');
    expect(normalizeUsageSource({})).toBe('other');
  });
});

describe('USAGE_SOURCE_LABELS', () => {
  it('has a non-empty label for every source', () => {
    for (const source of USAGE_SOURCES) {
      const label: string = USAGE_SOURCE_LABELS[source as AIUsageSource];
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
