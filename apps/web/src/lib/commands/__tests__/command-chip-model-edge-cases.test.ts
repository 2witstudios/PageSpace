/**
 * Universal Commands phase 6 — hostile-input edge cases for the transcript
 * rendering pipeline (preprocessCommandTokens → CommandChip view model).
 * Forged serializations must stay literal text or degrade to a muted chip;
 * they must never produce a navigable link from an attacker-controlled id
 * and never throw during render preprocessing.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCommandChipViewModel,
  isCommandInertForMessage,
  preprocessCommandTokens,
} from '../command-chip-model';
import { parseMessageTokens } from '@/lib/tokens/message-tokens';

const CMD_ID = 'tz4a98xxat96iws9zmbrgj3a';

describe('preprocessCommandTokens — forged tokens', () => {
  it('leaves a 64k-character label as literal text (over the 500-char token bound)', () => {
    const huge = 'a'.repeat(64 * 1024);
    const content = `/[${huge}](${CMD_ID}:command) hi`;
    expect(preprocessCommandTokens(content)).toBe(content);
  });

  it('leaves a mismatched sigil/type pair untouched', () => {
    const content = `@[fake](${CMD_ID}:command) and /[fake](page1:page)`;
    expect(preprocessCommandTokens(content)).toBe(content);
  });

  it('converts hostile ids without throwing; the resolve endpoint then marks them deleted', () => {
    // Conversion itself is mechanical — safety comes from resolution, which
    // shape-rejects these ids ('deleted' → muted, non-navigable chip).
    const traversal = preprocessCommandTokens('/[x](../../etc:command) hi');
    expect(traversal).toBe('[command:x](/command/../../etc) hi');

    const script = preprocessCommandTokens('/[x](<script>:command) hi');
    expect(script).toBe('[command:x](/command/<script>) hi');
  });

  it('handles a pathological number of command-shaped tokens without converting more than the first', () => {
    const content = Array.from({ length: 500 }, () => `/[x](${CMD_ID}:command)`).join(' ');
    const processed = preprocessCommandTokens(content);
    expect(processed.match(/\/command\//g)).toHaveLength(1);
  });
});

describe('buildCommandChipViewModel — forged ids degrade, never navigate', () => {
  it('renders a deleted resolution (what hostile ids resolve to) muted and non-navigable', () => {
    const vm = buildCommandChipViewModel('x', { state: 'deleted' });
    expect(vm.muted).toBe(true);
    expect(vm.navigable).toBe(false);
    expect(vm.href).toBeUndefined();
    expect(vm.tooltip).toContain('This command no longer exists.');
  });

  it('never emits an href when the viewer cannot view the entry page', () => {
    const vm = buildCommandChipViewModel('release-checklist', {
      state: 'ok',
      trigger: 'release-checklist',
      description: 'Run it.',
      scope: 'drive',
      enabled: true,
      entryPageId: '../../etc',
      entryPageTrashed: false,
      viewerCanViewEntryPage: false,
    });
    expect(vm.navigable).toBe(false);
    expect(vm.href).toBeUndefined();
  });

  it('renders the stored label verbatim after a trigger rename (stale by design, §2.1)', () => {
    const vm = buildCommandChipViewModel('release-checklist', {
      state: 'ok',
      trigger: 'release-checklist-v2',
      description: 'Renamed.',
      scope: 'user',
      enabled: true,
      entryPageId: 'pge9zmbrgj3atz4a98xxat96',
      entryPageTrashed: false,
      viewerCanViewEntryPage: true,
    });
    // Chip text keeps the label from the sent message; the tooltip carries
    // the current trigger so the rename is visible without rewriting history.
    expect(vm.text).toBe('/release-checklist');
    expect(vm.tooltip[0]).toContain('/release-checklist-v2');
    expect(vm.navigable).toBe(true);
  });
});

describe('one message, both token kinds — parsing stays disjoint', () => {
  it('parses a chip and mentions out of one message without corrupting either range', () => {
    const content = `@[Alice](usrali9zmbrgj3atz4a98xx:user) /[deploy](${CMD_ID}:command) @[Plan](pgeplan9zmbrgj3atz4a98xx:page)`;
    const { displayText, tokens } = parseMessageTokens(content);

    expect(displayText).toBe('@Alice /deploy @Plan');
    expect(tokens).toHaveLength(3);

    const command = tokens.find((token) => token.type === 'command');
    expect(command).toMatchObject({ id: CMD_ID, label: 'deploy' });
    // Token ranges are disjoint and each matches its display slice exactly.
    const sorted = [...tokens].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].end);
    }
    for (const token of sorted) {
      expect(displayText.slice(token.start, token.end)).toBe(
        `${token.type === 'command' ? '/' : '@'}${token.label}`
      );
    }
  });
});

describe('isCommandInertForMessage — §6 inert heuristic under hostile content', () => {
  it('stays inert (true) for a plain-user message with no agent mention', () => {
    expect(isCommandInertForMessage(`/[x](${CMD_ID}:command) hi`, false)).toBe(true);
  });

  it('is not inert when a page (agent) mention is present', () => {
    expect(
      isCommandInertForMessage(
        `/[x](${CMD_ID}:command) @[Helper](agt9zmbrgj3atz4a98xxat96:page)`,
        false
      )
    ).toBe(false);
  });

  it('handles a pathological long message without catastrophic backtracking', () => {
    const hostile = `${'@['.repeat(5_000)}${']('.repeat(5_000)}`;
    const start = Date.now();
    expect(isCommandInertForMessage(hostile, false)).toBe(true);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
