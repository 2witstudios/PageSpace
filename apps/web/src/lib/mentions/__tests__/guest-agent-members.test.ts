import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({ db: { select: vi.fn() } }));

import {
  shouldOfferGuestAgents,
  guestAgentSuggestion,
  type GuestAgentRow,
} from '../guest-agent-members';

const row: GuestAgentRow = {
  id: 'agent_aaaaaaaaaaaaaaaaaaaaaa',
  title: 'Guest Agent',
  memberDriveId: 'drive_member',
  homeDriveId: 'drive_home',
};

describe('shouldOfferGuestAgents', () => {
  const base = { requestedTypes: ['page'], pageTypeParam: null, imageOnly: false, excludePageTypes: new Set<string>() };

  it('offers guest agents for a plain page search', () => {
    expect(shouldOfferGuestAgents(base)).toBe(true);
  });

  it('offers them when the caller narrows to AI_CHAT explicitly', () => {
    expect(shouldOfferGuestAgents({ ...base, pageTypeParam: 'AI_CHAT' })).toBe(true);
  });

  it('does not offer them when pages are not requested at all', () => {
    expect(shouldOfferGuestAgents({ ...base, requestedTypes: ['user'] })).toBe(false);
  });

  it('does not offer them when the caller narrows to another page type', () => {
    expect(shouldOfferGuestAgents({ ...base, pageTypeParam: 'DOCUMENT' })).toBe(false);
  });

  it('does not offer them to an image picker', () => {
    expect(shouldOfferGuestAgents({ ...base, imageOnly: true })).toBe(false);
  });

  it('honours an explicit AI_CHAT exclusion (agent-pane page picker)', () => {
    expect(shouldOfferGuestAgents({ ...base, excludePageTypes: new Set(['FOLDER', 'AI_CHAT']) })).toBe(false);
  });
});

describe('guestAgentSuggestion', () => {
  it("presents the agent as a page mention in the CHANNEL's drive, never its home drive", () => {
    const suggestion = guestAgentSuggestion(row, { crossDrive: false, driveName: undefined });
    expect(suggestion).toEqual({
      id: row.id,
      label: 'Guest Agent',
      type: 'page',
      data: { pageType: 'AI_CHAT', driveId: 'drive_member', mimeType: null },
      description: `agent · ${row.id.slice(0, 6)}`,
    });
  });

  it('names the member drive in a cross-drive search', () => {
    const suggestion = guestAgentSuggestion(row, { crossDrive: true, driveName: 'Ops' });
    expect(suggestion.description).toBe(`agent in Ops · ${row.id.slice(0, 6)}`);
  });

  it('falls back to an untitled label', () => {
    expect(guestAgentSuggestion({ ...row, title: null }, { crossDrive: false, driveName: undefined }).label).toBe('Agent');
  });
});
