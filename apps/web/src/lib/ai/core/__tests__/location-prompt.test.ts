/**
 * Tests for apps/web/src/lib/ai/core/location-prompt.ts
 *
 * This block carries the "what page/drive is the user looking at right now"
 * text — it used to be baked into the stable system prompt (system-prompt.ts's
 * buildContextPrompt) but was moved here so it can be injected via the
 * volatile turn-context block instead, without busting the provider prompt
 * cache every time the user's location changes turn-to-turn.
 */

import { describe, it, expect } from 'vitest';
import { buildLocationTurnPrompt } from '../location-prompt';

describe('buildLocationTurnPrompt — no location (dashboard)', () => {
  it('given undefined input, returns dashboard guidance', () => {
    const result = buildLocationTurnPrompt(undefined);
    expect(result).toContain('dashboard');
    expect(result).toContain('list_drives');
  });

  it('given input with neither page nor drive, returns dashboard guidance', () => {
    const result = buildLocationTurnPrompt({ currentPage: null, currentDrive: null });
    expect(result).toContain('dashboard');
  });
});

describe('buildLocationTurnPrompt — drive only', () => {
  it('includes driveName to give the AI semantic workspace context', () => {
    const result = buildLocationTurnPrompt({
      currentDrive: { name: 'Marketing Team', slug: 'marketing-team', id: 'cuid_abc123' },
    });
    expect(result).toContain('Marketing Team');
  });

  it('includes driveSlug for tool routing', () => {
    const result = buildLocationTurnPrompt({
      currentDrive: { name: 'Confidential Workspace', slug: 'confidential-ws', id: 'cuid_xyz' },
    });
    expect(result).toContain('confidential-ws');
  });

  it('includes driveId for tool routing', () => {
    const result = buildLocationTurnPrompt({
      currentDrive: { name: 'My Private Drive', slug: 'my-private-drive', id: 'cuid_drive_007' },
    });
    expect(result).toContain('cuid_drive_007');
  });

  it('given a drive with no slug, still produces valid prompt', () => {
    const result = buildLocationTurnPrompt({
      currentDrive: { name: 'My Drive', id: 'cuid_1' },
    });
    expect(result).toContain('My Drive');
    expect(result).toContain('cuid_1');
  });
});

describe('buildLocationTurnPrompt — page context', () => {
  it('includes page title, type, and path', () => {
    const result = buildLocationTurnPrompt({
      currentPage: { title: 'Q3 Roadmap', type: 'DOCUMENT', path: '/drive/Q3 Roadmap' },
    });
    expect(result).toContain('Q3 Roadmap');
    expect(result).toContain('DOCUMENT');
    expect(result).toContain('/drive/Q3 Roadmap');
  });

  it('flags task-linked pages', () => {
    const result = buildLocationTurnPrompt({
      currentPage: { title: 'Fix login bug', type: 'TASK_LIST', path: '/drive/tasks/Fix login bug', isTaskLinked: true },
    });
    expect(result).toContain('linked to a task');
  });

  it('does not mention task-linking for a normal page', () => {
    const result = buildLocationTurnPrompt({
      currentPage: { title: 'Notes', type: 'DOCUMENT', path: '/drive/Notes' },
    });
    expect(result).not.toContain('linked to a task');
  });

  it('includes breadcrumbs when present', () => {
    const result = buildLocationTurnPrompt({
      currentPage: { title: 'Notes', type: 'DOCUMENT', path: '/drive/folder/Notes' },
      breadcrumbs: ['Drive', 'Folder', 'Notes'],
    });
    expect(result).toContain('Drive > Folder > Notes');
  });
});

describe('buildLocationTurnPrompt — "here" guidance', () => {
  it('tells the model what "here"/"this" refers to when a location is present', () => {
    const result = buildLocationTurnPrompt({
      currentDrive: { name: 'Team Drive', id: 'd1' },
    });
    expect(result.toLowerCase()).toContain('"here"');
  });
});
