import { describe, it, expect } from 'vitest';
import { FontFormatting } from '../font-formatting';

describe('font-formatting', () => {
  describe('FontFormatting extension', () => {
    it('should be a TipTap Extension', () => {
      expect(FontFormatting).toBeDefined();
      expect(FontFormatting.name).toBe('fontFormatting');
    });

    it('should define global attributes', () => {
      const config = FontFormatting.config;
      expect(config.addGlobalAttributes).toBeDefined();
    });
  });
});
