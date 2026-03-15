import { describe, it, expect } from 'vitest';
import {
  AI_PRIVACY,
  SHARING_PERMISSIONS,
  REALTIME_COLLABORATION,
  TROUBLESHOOTING,
} from '../content-other';

describe('content-other constants', () => {
  describe('AI_PRIVACY', () => {
    it('is defined and is a non-empty string', () => {
      expect(AI_PRIVACY).toBeDefined();
      expect(typeof AI_PRIVACY).toBe('string');
      expect(AI_PRIVACY.length).toBeGreaterThan(0);
    });

    it('contains AI & Privacy heading', () => {
      expect(AI_PRIVACY).toContain('AI & Privacy');
    });

    it('mentions local models and cloud models', () => {
      expect(AI_PRIVACY).toContain('local models');
      expect(AI_PRIVACY).toContain('cloud models');
    });

    it('is trimmed (no leading or trailing whitespace)', () => {
      expect(AI_PRIVACY).toBe(AI_PRIVACY.trim());
    });
  });

  describe('SHARING_PERMISSIONS', () => {
    it('is defined and is a non-empty string', () => {
      expect(SHARING_PERMISSIONS).toBeDefined();
      expect(typeof SHARING_PERMISSIONS).toBe('string');
      expect(SHARING_PERMISSIONS.length).toBeGreaterThan(0);
    });

    it('contains Sharing & Permissions heading', () => {
      expect(SHARING_PERMISSIONS).toContain('Sharing & Permissions');
    });

    it('mentions View and Edit access levels', () => {
      expect(SHARING_PERMISSIONS).toContain('View');
      expect(SHARING_PERMISSIONS).toContain('Edit');
    });

    it('is trimmed (no leading or trailing whitespace)', () => {
      expect(SHARING_PERMISSIONS).toBe(SHARING_PERMISSIONS.trim());
    });
  });

  describe('REALTIME_COLLABORATION', () => {
    it('is defined and is a non-empty string', () => {
      expect(REALTIME_COLLABORATION).toBeDefined();
      expect(typeof REALTIME_COLLABORATION).toBe('string');
      expect(REALTIME_COLLABORATION.length).toBeGreaterThan(0);
    });

    it('contains Real-time Collaboration heading', () => {
      expect(REALTIME_COLLABORATION).toContain('Real-time Collaboration');
    });

    it('mentions Documents and Task Lists', () => {
      expect(REALTIME_COLLABORATION).toContain('Documents');
      expect(REALTIME_COLLABORATION).toContain('Task Lists');
    });

    it('is trimmed (no leading or trailing whitespace)', () => {
      expect(REALTIME_COLLABORATION).toBe(REALTIME_COLLABORATION.trim());
    });
  });

  describe('TROUBLESHOOTING', () => {
    it('is defined and is a non-empty string', () => {
      expect(TROUBLESHOOTING).toBeDefined();
      expect(typeof TROUBLESHOOTING).toBe('string');
      expect(TROUBLESHOOTING.length).toBeGreaterThan(0);
    });

    it('contains Troubleshooting heading', () => {
      expect(TROUBLESHOOTING).toContain('Troubleshooting');
    });

    it('mentions common problems', () => {
      // The source file uses curly/smart quotes (U+2019) in headings like "I can't edit"
      // Test for plain ASCII substrings that are present regardless of quote style
      expect(TROUBLESHOOTING).toContain('edit permission');
      expect(TROUBLESHOOTING).toContain('File preview');
    });

    it('is trimmed (no leading or trailing whitespace)', () => {
      expect(TROUBLESHOOTING).toBe(TROUBLESHOOTING.trim());
    });
  });

  describe('all exports together', () => {
    it('each constant is distinct', () => {
      const constants = [AI_PRIVACY, SHARING_PERMISSIONS, REALTIME_COLLABORATION, TROUBLESHOOTING];
      const unique = new Set(constants);
      expect(unique.size).toBe(4);
    });
  });
});
