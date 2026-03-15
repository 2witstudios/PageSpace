import { describe, it, expect } from 'vitest';

import {
  buildPersonalizationPrompt,
  buildSystemPrompt,
  getWelcomeMessage,
  getErrorMessage,
  estimateSystemPromptTokens,
} from '../system-prompt';

import type { PersonalizationInfo, ContextInfo } from '../system-prompt';

describe('system-prompt', () => {
  describe('buildPersonalizationPrompt', () => {
    it('should return null when personalization is disabled', () => {
      const personalization: PersonalizationInfo = { enabled: false };
      expect(buildPersonalizationPrompt(personalization)).toBeNull();
    });

    it('should return null when personalization is undefined', () => {
      expect(buildPersonalizationPrompt(undefined)).toBeNull();
    });

    it('should return null when all fields are empty but enabled', () => {
      const personalization: PersonalizationInfo = { enabled: true };
      expect(buildPersonalizationPrompt(personalization)).toBeNull();
    });

    it('should include bio when provided', () => {
      const personalization: PersonalizationInfo = {
        enabled: true,
        bio: 'I am a software developer',
      };
      const result = buildPersonalizationPrompt(personalization);
      expect(result).toContain('I am a software developer');
      expect(result).toContain('ABOUT THE USER');
    });

    it('should include writingStyle when provided', () => {
      const personalization: PersonalizationInfo = {
        enabled: true,
        writingStyle: 'Concise and technical',
      };
      const result = buildPersonalizationPrompt(personalization);
      expect(result).toContain('Concise and technical');
      expect(result).toContain('COMMUNICATION PREFERENCES');
    });

    it('should include rules when provided', () => {
      const personalization: PersonalizationInfo = {
        enabled: true,
        rules: 'Always use TypeScript',
      };
      const result = buildPersonalizationPrompt(personalization);
      expect(result).toContain('Always use TypeScript');
      expect(result).toContain('USER RULES');
    });

    it('should include all sections when all fields provided', () => {
      const personalization: PersonalizationInfo = {
        enabled: true,
        bio: 'Developer',
        writingStyle: 'Technical',
        rules: 'No shortcuts',
      };
      const result = buildPersonalizationPrompt(personalization);
      expect(result).toContain('ABOUT THE USER');
      expect(result).toContain('COMMUNICATION PREFERENCES');
      expect(result).toContain('USER RULES');
      expect(result).toContain('# USER PERSONALIZATION');
    });

    it('should return null when bio is only whitespace', () => {
      const personalization: PersonalizationInfo = {
        enabled: true,
        bio: '   ',
      };
      expect(buildPersonalizationPrompt(personalization)).toBeNull();
    });

    it('should trim bio content', () => {
      const personalization: PersonalizationInfo = {
        enabled: true,
        bio: '  Developer  ',
      };
      const result = buildPersonalizationPrompt(personalization);
      expect(result).toContain('Developer');
    });
  });

  describe('buildSystemPrompt', () => {
    it('should build a system prompt for dashboard context', () => {
      const result = buildSystemPrompt('dashboard');
      expect(result).toContain('# PAGESPACE AI');
      // Without contextInfo, falls back to "Operating in dashboard mode."
      expect(result).toContain('dashboard');
    });

    it('should build a system prompt for dashboard context with contextInfo', () => {
      const result = buildSystemPrompt('dashboard', {});
      expect(result).toContain('# PAGESPACE AI');
      expect(result).toContain('DASHBOARD CONTEXT');
    });

    it('should build a system prompt for drive context with info', () => {
      const contextInfo: ContextInfo = {
        driveName: 'My Drive',
        driveSlug: 'my-drive',
        driveId: 'drive-123',
      };
      const result = buildSystemPrompt('drive', contextInfo);
      expect(result).toContain('My Drive');
      expect(result).toContain('my-drive');
      expect(result).toContain('drive-123');
      expect(result).toContain('DRIVE CONTEXT');
    });

    it('should build a system prompt for page context with info', () => {
      const contextInfo: ContextInfo = {
        pagePath: '/my-drive/my-page',
        pageType: 'DOCUMENT',
        breadcrumbs: ['My Drive', 'My Page'],
      };
      const result = buildSystemPrompt('page', contextInfo);
      expect(result).toContain('/my-drive/my-page');
      expect(result).toContain('DOCUMENT');
      expect(result).toContain('My Drive');
      expect(result).toContain('My Page');
      expect(result).toContain('PAGE CONTEXT');
    });

    it('should include read-only constraint when isReadOnly is true', () => {
      const result = buildSystemPrompt('dashboard', undefined, true);
      expect(result).toContain('READ-ONLY MODE');
    });

    it('should not include read-only constraint when isReadOnly is false', () => {
      const result = buildSystemPrompt('dashboard', undefined, false);
      expect(result).not.toContain('READ-ONLY MODE');
    });

    it('should include personalization when provided', () => {
      const personalization: PersonalizationInfo = {
        enabled: true,
        bio: 'I am a developer',
      };
      const result = buildSystemPrompt('dashboard', undefined, false, personalization);
      expect(result).toContain('I am a developer');
    });

    it('should not include personalization section when disabled', () => {
      const personalization: PersonalizationInfo = { enabled: false };
      const result = buildSystemPrompt('dashboard', undefined, false, personalization);
      expect(result).not.toContain('USER PERSONALIZATION');
    });

    it('should include BEHAVIOR_PROMPT section', () => {
      const result = buildSystemPrompt('dashboard');
      expect(result).toContain('APPROACH');
      expect(result).toContain('STYLE');
    });

    it('should modify core prompt text in read-only mode', () => {
      const result = buildSystemPrompt('dashboard', undefined, true);
      expect(result).toContain('read-only mode');
    });
  });

  describe('getWelcomeMessage', () => {
    it('should return read-only welcome message when isReadOnly is true', () => {
      const result = getWelcomeMessage(true);
      expect(result).toContain('read-only mode');
      expect(result).not.toContain('Welcome!');
    });

    it('should return standard welcome message when isReadOnly is false', () => {
      const result = getWelcomeMessage(false);
      expect(result).not.toContain('read-only mode');
      expect(result).not.toContain('Welcome!');
    });

    it('should include "Welcome!" prefix when isNew is true', () => {
      const result = getWelcomeMessage(false, true);
      expect(result).toContain('Welcome!');
    });

    it('should not include "Welcome!" prefix when isNew is false', () => {
      const result = getWelcomeMessage(false, false);
      expect(result).not.toContain('Welcome!');
    });

    it('should include "Welcome!" with read-only when isNew is true and isReadOnly is true', () => {
      const result = getWelcomeMessage(true, true);
      expect(result).toContain('Welcome!');
      expect(result).toContain('read-only mode');
    });
  });

  describe('getErrorMessage', () => {
    it('should include the error in the message', () => {
      const result = getErrorMessage('Something went wrong');
      expect(result).toContain('Something went wrong');
    });

    it('should suggest trying a different approach', () => {
      const result = getErrorMessage('Network error');
      expect(result).toContain('different approach');
    });
  });

  describe('estimateSystemPromptTokens', () => {
    it('should return 0 for empty string', () => {
      expect(estimateSystemPromptTokens('')).toBe(0);
    });

    it('should estimate tokens as ceil(length / 4)', () => {
      const prompt = 'a'.repeat(100);
      expect(estimateSystemPromptTokens(prompt)).toBe(25);
    });

    it('should round up for non-divisible lengths', () => {
      const prompt = 'a'.repeat(101);
      expect(estimateSystemPromptTokens(prompt)).toBe(26);
    });

    it('should handle a realistic prompt', () => {
      const prompt = 'You are PageSpace AI. You can explore the workspace.';
      const tokens = estimateSystemPromptTokens(prompt);
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBe(Math.ceil(prompt.length / 4));
    });
  });
});
