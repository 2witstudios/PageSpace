import { describe, it, expect } from 'vitest';
import { toTitleCase, getLanguageFromPath } from '../formatters';

describe('formatters', () => {
  describe('toTitleCase', () => {
    it('should convert underscore-separated string to title case', () => {
      expect(toTitleCase('hello_world')).toBe('Hello World');
    });

    it('should handle single word', () => {
      expect(toTitleCase('hello')).toBe('Hello');
    });

    it('should handle uppercase input', () => {
      expect(toTitleCase('HELLO_WORLD')).toBe('Hello World');
    });

    it('should handle empty string', () => {
      expect(toTitleCase('')).toBe('');
    });

    it('should handle multiple underscores', () => {
      expect(toTitleCase('one_two_three_four')).toBe('One Two Three Four');
    });
  });

  describe('getLanguageFromPath', () => {
    it('should return typescript for .ts files', () => {
      expect(getLanguageFromPath('src/file.ts')).toBe('typescript');
    });

    it('should return tsx for .tsx files', () => {
      expect(getLanguageFromPath('component.tsx')).toBe('tsx');
    });

    it('should return javascript for .js files', () => {
      expect(getLanguageFromPath('script.js')).toBe('javascript');
    });

    it('should return python for .py files', () => {
      expect(getLanguageFromPath('main.py')).toBe('python');
    });

    it('should return bash for .sh files', () => {
      expect(getLanguageFromPath('deploy.sh')).toBe('bash');
    });

    it('should return bash for .zsh files', () => {
      expect(getLanguageFromPath('setup.zsh')).toBe('bash');
    });

    it('should return yaml for .yml files', () => {
      expect(getLanguageFromPath('config.yml')).toBe('yaml');
    });

    it('should return yaml for .yaml files', () => {
      expect(getLanguageFromPath('config.yaml')).toBe('yaml');
    });

    it('should return text for unknown extensions', () => {
      expect(getLanguageFromPath('file.xyz')).toBe('text');
    });

    it('should return text when path is undefined', () => {
      expect(getLanguageFromPath(undefined)).toBe('text');
    });

    it('should return text when path is empty', () => {
      expect(getLanguageFromPath('')).toBe('text');
    });

    it('should handle case-insensitive extensions', () => {
      expect(getLanguageFromPath('file.JSON')).toBe('json');
    });

    it('should return sql for .sql files', () => {
      expect(getLanguageFromPath('query.sql')).toBe('sql');
    });

    it('should return rust for .rs files', () => {
      expect(getLanguageFromPath('main.rs')).toBe('rust');
    });

    it('should return go for .go files', () => {
      expect(getLanguageFromPath('server.go')).toBe('go');
    });
  });
});
