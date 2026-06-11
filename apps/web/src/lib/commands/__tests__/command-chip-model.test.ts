import { describe, it, expect } from 'vitest';
import {
  buildCommandChipViewModel,
  preprocessCommandTokens,
  type CommandChipResolution,
} from '../command-chip-model';

const okResolution: CommandChipResolution = {
  state: 'ok',
  trigger: 'release-checklist',
  description: 'Run the release checklist.',
  scope: 'user',
  enabled: true,
  entryPageId: 'page-1',
  entryPageTrashed: false,
  viewerCanViewEntryPage: true,
};

describe('buildCommandChipViewModel — normal rendering (spec §5.1)', () => {
  it('renders /label, navigable to the entry page, with trigger+description+scope tooltip', () => {
    const vm = buildCommandChipViewModel('release-checklist', okResolution);
    expect(vm.text).toBe('/release-checklist');
    expect(vm.muted).toBe(false);
    expect(vm.navigable).toBe(true);
    expect(vm.href).toBe('/p/page-1');
    expect(vm.tooltip).toContain('/release-checklist — Run the release checklist.');
    expect(vm.tooltip).toContain('Personal command');
  });

  it('labels drive and built-in scopes', () => {
    expect(
      buildCommandChipViewModel('x', { ...okResolution, scope: 'drive' }).tooltip
    ).toContain('Drive command');
    expect(
      buildCommandChipViewModel('x', { ...okResolution, scope: 'builtin' }).tooltip
    ).toContain('Built-in command');
  });

  it('renders a non-navigable plain chip while resolution is loading', () => {
    const vm = buildCommandChipViewModel('foo', { state: 'loading' });
    expect(vm.text).toBe('/foo');
    expect(vm.muted).toBe(false);
    expect(vm.navigable).toBe(false);
    expect(vm.tooltip).toEqual(['/foo']);
  });
});

describe('buildCommandChipViewModel — deleted / disabled (spec §5.2)', () => {
  it('renders a deleted command muted, non-navigable, with the §5.2 tooltip', () => {
    const vm = buildCommandChipViewModel('gone', { state: 'deleted' });
    expect(vm.text).toBe('/gone');
    expect(vm.muted).toBe(true);
    expect(vm.navigable).toBe(false);
    expect(vm.tooltip).toContain('This command no longer exists.');
  });

  it('renders a disabled command normally with the disabled tooltip suffix', () => {
    const vm = buildCommandChipViewModel('foo', { ...okResolution, enabled: false });
    expect(vm.muted).toBe(false);
    expect(vm.navigable).toBe(true);
    expect(vm.tooltip).toContain('This command is currently disabled.');
  });
});

describe('buildCommandChipViewModel — revoked access / trashed entry page (spec §5.3)', () => {
  it('renders normally but non-navigable when the viewer lacks entry page access', () => {
    const vm = buildCommandChipViewModel('foo', {
      ...okResolution,
      viewerCanViewEntryPage: false,
    });
    expect(vm.muted).toBe(false);
    expect(vm.navigable).toBe(false);
    expect(vm.href).toBeUndefined();
    expect(vm.tooltip).toContain("You don't have access to this command's page.");
  });

  it('uses the unavailable treatment when the entry page is trashed', () => {
    const vm = buildCommandChipViewModel('foo', { ...okResolution, entryPageTrashed: true });
    expect(vm.muted).toBe(true);
    expect(vm.navigable).toBe(false);
    expect(vm.tooltip).toContain("This command's page is in the trash.");
  });
});

describe('buildCommandChipViewModel — restricted metadata', () => {
  it('renders the stored label with a generic tooltip when the viewer cannot see the command', () => {
    const vm = buildCommandChipViewModel('private-cmd', { state: 'restricted' });
    expect(vm.text).toBe('/private-cmd');
    expect(vm.muted).toBe(false);
    expect(vm.navigable).toBe(false);
    expect(vm.tooltip).toEqual(['/private-cmd', 'Command']);
  });
});

describe('buildCommandChipViewModel — inert in conversations without AI (spec §6)', () => {
  it('appends the inert suffix', () => {
    const vm = buildCommandChipViewModel('foo', okResolution, { inertNoAI: true });
    expect(vm.tooltip).toContain("No AI is in this conversation, so this command didn't run.");
  });
});

describe('preprocessCommandTokens', () => {
  it('converts the leading command token to a /command/ markdown link', () => {
    expect(preprocessCommandTokens('/[foo](cmd123:command) ship it')).toBe(
      '[command:foo](/command/cmd123) ship it'
    );
  });

  it('keeps a command after preceding text (chip validity is set at insertion, §2.3)', () => {
    expect(preprocessCommandTokens('hey /[foo](cmd123:command) now')).toBe(
      'hey [command:foo](/command/cmd123) now'
    );
  });

  it('splits built-in ids on the last colon', () => {
    expect(preprocessCommandTokens('/[help](builtin:help:command) hi')).toBe(
      '[command:help](/command/builtin:help) hi'
    );
  });

  it('converts only the first command token (one command per message)', () => {
    expect(preprocessCommandTokens('/[a](c1:command) and /[b](c2:command)')).toBe(
      '[command:a](/command/c1) and /[b](c2:command)'
    );
  });

  it('leaves mentions and plain text untouched', () => {
    const content = '@[Alice](u1:user) hello /plain';
    expect(preprocessCommandTokens(content)).toBe(content);
  });
});
