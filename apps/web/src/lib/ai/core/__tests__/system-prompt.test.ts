/**
 * Tests for apps/web/src/lib/ai/core/system-prompt.ts
 *
 * Covers:
 * - buildSystemPrompt: dashboard, drive, page context types
 * - buildPersonalizationPrompt: enabled/disabled, section presence
 * - getWelcomeMessage / getErrorMessage
 * - estimateSystemPromptTokens
 */

import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt,
  buildPersonalizationPrompt,
  getWelcomeMessage,
  getErrorMessage,
  estimateSystemPromptTokens,
} from '../system-prompt';

describe('buildSystemPrompt — drive context', () => {
  it('given drive context, should include driveName to give AI semantic workspace context', () => {
    const result = buildSystemPrompt('drive', {
      driveName: 'Marketing Team',
      driveSlug: 'marketing-team',
      driveId: 'cuid_abc123',
    });

    expect(result).toContain('Marketing Team');
  });

  it('given drive context, should include driveSlug for tool routing', () => {
    const result = buildSystemPrompt('drive', {
      driveName: 'Confidential Workspace',
      driveSlug: 'confidential-ws',
      driveId: 'cuid_xyz',
    });

    expect(result).toContain('confidential-ws');
  });

  it('given drive context, should include driveId for tool routing', () => {
    const result = buildSystemPrompt('drive', {
      driveName: 'My Private Drive',
      driveSlug: 'my-private-drive',
      driveId: 'cuid_drive_007',
    });

    expect(result).toContain('cuid_drive_007');
  });
});

describe('buildSystemPrompt — general', () => {
  it('given dashboard context, returns string containing core prompt text', () => {
    const result = buildSystemPrompt('dashboard');
    expect(result).toContain('PageSpace AI');
  });

  it('given read-only mode, includes READ-ONLY constraint', () => {
    const result = buildSystemPrompt('dashboard', undefined, true);
    expect(result).toContain('READ-ONLY');
  });

  it('given non-read-only mode, does not include READ-ONLY constraint', () => {
    const result = buildSystemPrompt('dashboard', undefined, false);
    expect(result).not.toContain('READ-ONLY');
  });

  it('given drive context with no driveName, still produces valid prompt', () => {
    const result = buildSystemPrompt('drive', {
      driveSlug: 'my-drive',
      driveId: 'cuid_1',
    });
    expect(result).toContain('my-drive');
  });
});

describe('buildPersonalizationPrompt', () => {
  it('returns null when personalization is disabled', () => {
    const result = buildPersonalizationPrompt({ enabled: false });
    expect(result).toBeNull();
  });

  it('returns null when personalization is undefined', () => {
    const result = buildPersonalizationPrompt(undefined);
    expect(result).toBeNull();
  });

  it('returns null when enabled but all fields empty', () => {
    const result = buildPersonalizationPrompt({ enabled: true });
    expect(result).toBeNull();
  });

  it('includes bio section when present', () => {
    const result = buildPersonalizationPrompt({ enabled: true, bio: 'I am a developer' });
    expect(result).toContain('I am a developer');
  });

  it('includes writingStyle section when present', () => {
    const result = buildPersonalizationPrompt({ enabled: true, writingStyle: 'Concise and direct' });
    expect(result).toContain('Concise and direct');
  });

  it('includes rules section when present', () => {
    const result = buildPersonalizationPrompt({ enabled: true, rules: 'Always use TypeScript' });
    expect(result).toContain('Always use TypeScript');
  });
});

describe('getWelcomeMessage', () => {
  it('returns read-only message when isReadOnly is true', () => {
    const result = getWelcomeMessage(true);
    expect(result).toContain('read-only');
  });

  it('returns regular message when isReadOnly is false', () => {
    const result = getWelcomeMessage(false);
    expect(result).not.toContain('read-only');
  });

  it('includes Welcome prefix when isNew is true', () => {
    const result = getWelcomeMessage(false, true);
    expect(result).toContain('Welcome');
  });
});

describe('getErrorMessage', () => {
  it('includes the error string in the message', () => {
    const result = getErrorMessage('connection timeout');
    expect(result).toContain('connection timeout');
  });
});

describe('estimateSystemPromptTokens', () => {
  it('estimates ~1 token per 4 characters', () => {
    const prompt = 'a'.repeat(400);
    expect(estimateSystemPromptTokens(prompt)).toBe(100);
  });

  it('rounds up fractional tokens', () => {
    expect(estimateSystemPromptTokens('abc')).toBe(1);
  });
});
