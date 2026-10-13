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

  it('renders the page id so the model can address the page directly', () => {
    const result = buildLocationTurnPrompt({
      currentPage: { id: 'pg_abc123', title: 'Q3 Roadmap', type: 'DOCUMENT', path: '/drive/Q3 Roadmap' },
    });
    expect(result).toContain('pageId: pg_abc123');
  });

  it('omits the page id marker when no id is supplied', () => {
    const result = buildLocationTurnPrompt({
      currentPage: { title: 'Notes', type: 'DOCUMENT', path: '/drive/Notes' },
    });
    expect(result).not.toContain('pageId:');
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

describe('no-location Home drive hint', () => {
  it('omits any Home reference when no hint is supplied', () => {
    const result = buildLocationTurnPrompt(undefined);
    expect(result).not.toContain('driveId:');
    expect(result).toContain('Do NOT default to the Home drive');
  });

  it('labels the Home id as off-limits rather than contradicting the guard', () => {
    // The guard and the hint must read as ONE rule. "Do NOT assume the Home
    // drive" sitting next to a bare Home driveId leaves the model to resolve a
    // contradiction, and resolving it wrongly is the exact bug the guard exists
    // to prevent.
    const result = buildLocationTurnPrompt({ homeDriveId: 'drv_home' });
    expect(result).toContain('drv_home');
    expect(result).toContain('do NOT write here unless');
    // The guard itself is scoped, not deleted.
    expect(result).toContain('Do NOT default to the Home drive for general work');
  });
});

describe('buildLocationTurnPrompt — agent access (IMG-10.10, a drive the user keeps Imago out of)', () => {
  const drive = { name: 'Acme Plans', slug: 'acme', id: 'drive_acme' };

  it('given no agentAccess, should render exactly what it rendered before', () => {
    expect(buildLocationTurnPrompt({ currentDrive: drive, agentAccess: undefined })).toBe(
      buildLocationTurnPrompt({ currentDrive: drive }),
    );
  });

  it('given a drive the user keeps Imago out of, should say so, name nothing in it, and drop the defaults that would send the agent there', () => {
    const page = { title: 'Secret Plan', type: 'DOCUMENT', path: '/acme/secret', id: 'page_secret' };
    const result = buildLocationTurnPrompt({ currentDrive: drive, currentPage: page, breadcrumbs: ['Acme Plans', 'Secret Plan'], agentAccess: { kind: 'excluded' } });
    expect(result).toContain('a workspace they keep you out of');
    for (const hidden of ['Acme Plans', 'Secret Plan', 'drive_acme', 'page_secret', '/acme/secret']) expect(result).not.toContain(hidden);
    expect(result).not.toContain('Default scope');
    expect(result).not.toContain('Start with list_pages on this drive');
    expect(result).not.toContain('to act on THIS workspace');
  });

  it('given no location at all, should ignore agentAccess', () => {
    expect(buildLocationTurnPrompt({ agentAccess: { kind: 'excluded' } })).toBe(buildLocationTurnPrompt({}));
  });
});
