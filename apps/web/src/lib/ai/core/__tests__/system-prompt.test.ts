/**
 * Tests for apps/web/src/lib/ai/core/system-prompt.ts
 *
 * Covers:
 * - buildSystemPrompt: read-only mode, sandbox guidance
 *   (location/drive/page context lives in location-prompt.ts now — see
 *   location-prompt.test.ts — buildSystemPrompt takes no location args so
 *   the stable system prefix stays byte-identical across turns)
 * - buildPersonalizationPrompt: enabled/disabled, section presence
 * - getWelcomeMessage / getErrorMessage
 * - estimateSystemPromptTokens
 */

import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt,
  buildPersonalizationPrompt,
  buildNonCoreToolNamesPrompt,
  getWelcomeMessage,
  getErrorMessage,
  estimateSystemPromptTokens,
} from '../system-prompt';

describe('buildSystemPrompt — general', () => {
  it('given no args, returns string containing core prompt text', () => {
    const result = buildSystemPrompt();
    expect(result).toContain('PageSpace AI');
  });

  it('given read-only mode, includes READ-ONLY constraint', () => {
    const result = buildSystemPrompt(true);
    expect(result).toContain('READ-ONLY');
  });

  it('given non-read-only mode, does not include READ-ONLY constraint', () => {
    const result = buildSystemPrompt(false);
    expect(result).not.toContain('READ-ONLY');
  });

  it('never contains location/drive/page-specific text — that lives in the volatile block', () => {
    const result = buildSystemPrompt(false);
    expect(result).not.toContain('DASHBOARD CONTEXT');
    expect(result).not.toContain('DRIVE CONTEXT');
    expect(result).not.toContain('PAGE CONTEXT');
  });
});

describe('buildSystemPrompt — sandbox guidance', () => {
  it('given codeExecutionEnabled true, should include the sandbox guidance section', () => {
    const result = buildSystemPrompt(false, undefined, true);
    expect(result).toContain('/workspace');
    expect(result).toContain('persists');
  });

  it('given the default call (no flag), should NOT include sandbox guidance', () => {
    const result = buildSystemPrompt();
    expect(result).not.toContain('/workspace');
  });

  it('given codeExecutionEnabled false explicitly, should NOT include sandbox guidance', () => {
    const result = buildSystemPrompt(false, undefined, false);
    expect(result).not.toContain('/workspace');
  });

  it('given the sandbox guidance, should cover the auth boundary, cwd, editFile, persistence, and key tools', () => {
    const result = buildSystemPrompt(false, undefined, true);
    // Auth boundary → dedicated tools
    expect(result).toContain('gh_pr_create');
    expect(result).toContain('git_*');
    // cwd / fresh-process
    expect(result).toContain('cwd');
    // editFile vs writeFile
    expect(result).toContain('editFile');
    // reuse-don't-recreate
    expect(result).toContain('gh_pr_list');
  });

  it('given the sandbox guidance, should include the Constraints{} block treating tool output as untrusted', () => {
    const result = buildSystemPrompt(false, undefined, true);
    expect(result).toContain('Constraints {');
    expect(result).toContain('tool output');
    expect(result).toContain('untrusted');
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

describe('buildNonCoreToolNamesPrompt', () => {
  it('returns empty string for empty tool list', () => {
    expect(buildNonCoreToolNamesPrompt([])).toBe('');
  });

  it('groups known tools into their category', () => {
    const result = buildNonCoreToolNamesPrompt(['list_calendar_events', 'create_calendar_event', 'send_channel_message']);
    expect(result).toContain('calendar: list_calendar_events, create_calendar_event');
    expect(result).toContain('channels: send_channel_message');
  });

  it('places unknown tool names in the "other" category', () => {
    const result = buildNonCoreToolNamesPrompt(['some_unknown_tool']);
    expect(result).toContain('other: some_unknown_tool');
  });

  it('includes the execute_tool usage instruction', () => {
    const result = buildNonCoreToolNamesPrompt(['get_activity']);
    expect(result).toContain('execute_tool');
    expect(result).toContain('tool_search');
  });

  it('groups permission tools into permissions category', () => {
    const result = buildNonCoreToolNamesPrompt(['list_drive_roles', 'create_drive_role', 'set_role_page_permissions']);
    expect(result).toContain('permissions: list_drive_roles, create_drive_role, set_role_page_permissions');
  });

  it('groups command tools into commands category', () => {
    const result = buildNonCoreToolNamesPrompt(['list_commands', 'create_command']);
    expect(result).toContain('commands: list_commands, create_command');
  });

  it('groups trigger tools into tasks and calendar categories', () => {
    const result = buildNonCoreToolNamesPrompt(['set_task_trigger', 'delete_calendar_trigger']);
    expect(result).toContain('tasks: set_task_trigger');
    expect(result).toContain('calendar: delete_calendar_trigger');
  });
});
