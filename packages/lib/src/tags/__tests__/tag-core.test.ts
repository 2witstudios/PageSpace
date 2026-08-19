import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { PAGE_TYPE_VALUES, type PageTypeValue } from '../../utils/enums';
import { PAGE_TYPE_CONFIGS } from '../../content/page-types.config';
import type { SheetCellAnchor, TextAnchor } from '../../content/anchoring/types';
import {
  MAX_RAW_TAG_INPUT,
  MAX_TAG_KEY_LENGTH,
  MAX_TAG_NAME_LENGTH,
  TAG_TARGETS,
  type TagTarget,
  type TargetKind,
  normalizeTagName,
  tagKey,
  validateTarget,
} from '../tag-core';

/**
 * Fixtures are built from code points rather than pasted literals. Half of what
 * this module does is police invisible characters, and a literal one in a test
 * is invisible in a diff too — you cannot review what you cannot see, and a
 * stray copy-paste would silently change what the test asserts.
 */
const U = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

const ZWSP = U(0x200b);
const ZWNJ = U(0x200c);
const ZWJ = U(0x200d);
const RLO = U(0x202e);
const SHY = U(0x00ad);
const BOM = U(0xfeff);
const NBSP = U(0x00a0);
const EM_SPACE = U(0x2003);
const IDEOGRAPHIC_SPACE = U(0x3000);
const OGHAM_SPACE = U(0x1680);
const COMBINING_ACUTE = U(0x0301);
const E_ACUTE = U(0x00e9);
const FAMILY = U(0x1f468) + ZWJ + U(0x1f469) + ZWJ + U(0x1f467);

function expectOk(raw: string): { name: string; key: string } {
  const result = normalizeTagName(raw);
  expect(result.ok, `expected ${JSON.stringify(raw)} to normalize`).toBe(true);
  if (!result.ok) {
    throw new Error('unreachable');
  }
  return { name: result.name, key: result.key };
}

describe('normalizeTagName — the dedupe contract', () => {
  it('collapses casing to one key while preserving each writer’s name', () => {
    const upper = expectOk('CAF' + U(0x00c9));
    const title = expectOk('Caf' + E_ACUTE);
    const lower = expectOk('caf' + E_ACUTE);

    expect(new Set([upper.key, title.key, lower.key]).size).toBe(1);
    expect(upper.key).toBe('caf' + E_ACUTE);
    // First writer's casing wins, so the names must NOT have been folded.
    expect(new Set([upper.name, title.name, lower.name]).size).toBe(3);
  });

  it('makes a decomposed name byte-identical to its precomposed twin', () => {
    // Both paths must agree, or two visually identical tags become two rows and
    // Postgres compares them as different strings.
    const composed = expectOk('caf' + E_ACUTE);
    const decomposed = expectOk('cafe' + COMBINING_ACUTE);

    expect(decomposed.name).toBe(composed.name);
    expect(decomposed.key).toBe(composed.key);
  });

  it('keeps non-Latin scripts and emoji intact — the case slugify destroys', () => {
    expect(expectOk(U(0x65e5, 0x672c, 0x8a9e)).name).toBe(U(0x65e5, 0x672c, 0x8a9e));
    expect(expectOk(U(0x1f525)).name).toBe(U(0x1f525));
    expect(expectOk('Ünder').name).toBe('Ünder');
  });
});

describe('normalizeTagName — NFC for the name, NFKC for the key', () => {
  it('folds compatibility variants in the key so lookalikes are one tag', () => {
    expect(expectOk(U(0xff26, 0xff55, 0xff4c, 0xff4c)).key).toBe('full');
    expect(expectOk(U(0xfb01) + 'ction').key).toBe('fiction');
    expect(expectOk(U(0x2460)).key).toBe('1');
    // A mathematical-script duplicate of an existing tag resolves to it.
    expect(expectOk(U(0x1d436, 0x1d698, 0x1d698, 0x1d695)).key).toBe('cool');
  });

  it('does NOT fold them in the name, because NFKC is lossy for display', () => {
    // Each of these would silently rewrite what the user typed.
    expect(expectOk(U(0x33a1)).name).toBe(U(0x33a1));
    expect(expectOk(U(0x33a1)).key).toBe('m2');
    expect(expectOk('x' + U(0x00b2)).name).toBe('x' + U(0x00b2));
    expect(expectOk('x' + U(0x00b2)).key).toBe('x2');
    expect(expectOk(U(0xff26, 0xff55, 0xff4c, 0xff4c)).name).toBe(U(0xff26, 0xff55, 0xff4c, 0xff4c));
  });

  it('normalizes before folding, or the key comes out uppercase', () => {
    // Lowercasing the TELEPHONE SIGN is a no-op; NFKC then yields 'TEL'. Only
    // NFKC-then-fold gives a usable key, so this pins the order.
    expect(expectOk(U(0x2121)).key).toBe('tel');
  });

  it('an acute accent decomposes to a space plus a combining mark under NFKC', () => {
    // The name keeps the character the user typed; the key trims the injected
    // leading space rather than storing one.
    const acute = expectOk(U(0x00b4));
    expect(acute.name).toBe(U(0x00b4));
    expect(acute.key).toBe(COMBINING_ACUTE);
  });
});

describe('normalizeTagName — case folding limits, documented not hidden', () => {
  it('folds the Greek final sigma so one word is one tag', () => {
    // Without the patch, uppercase Greek lowercases to a FINAL sigma and a user
    // typing the medial form gets a second tag for the same word.
    const upper = expectOk(U(0x39f, 0x394, 0x39f, 0x3a3));
    const medial = expectOk(U(0x3bf, 0x3b4, 0x3bf, 0x3c3));

    expect(upper.key).toBe(medial.key);
    expect(upper.key).not.toContain(U(0x3c2));
  });

  it('does NOT fold sharp s against a doubled S — deliberate, not an oversight', () => {
    // Folding these would also merge two different German words, so the split
    // is the more correct behaviour. Pinned so nobody "fixes" it.
    expect(expectOk('Stra' + U(0x00df) + 'e').key).not.toBe(expectOk('STRASSE').key);
    // The capital sharp s does fold, because toLowerCase handles it.
    expect(expectOk('STRA' + U(0x1e9e) + 'E').key).toBe(expectOk('Stra' + U(0x00df) + 'e').key);
  });

  it('does NOT fold the Turkish dotted I — matches Unicode default folding', () => {
    expect(expectOk(U(0x0130) + 'STANBUL').key).not.toBe(expectOk('istanbul').key);
  });

  it('folds digraphs and ligatures that only NFKC can reach', () => {
    expect(expectOk(U(0x01c4)).key).toBe(expectOk(U(0x01c6)).key);
    expect(expectOk(U(0xfb00)).key).toBe(expectOk('ff').key);
    expect(expectOk(U(0x13a0)).key).toBe(expectOk(U(0xab70)).key);
  });

  it('keys the letter I the same way on every host', () => {
    // The test that fails if anyone reaches for toLocaleLowerCase: on a Turkish
    // machine that would key 'IT' as a dotless i and miss the row it should
    // dedupe against.
    expect(expectOk('IT').key).toBe('it');
  });
});

describe('normalizeTagName — invisible characters', () => {
  it('strips the ones that are pure noise or pure spoofing', () => {
    expect(expectOk('a' + ZWSP + 'b').name).toBe('ab');
    expect(expectOk(SHY + 'tag').name).toBe('tag');
    expect(expectOk(BOM + 'tag').name).toBe('tag');
    expect(expectOk(RLO + 'evil').name).toBe('evil');
    expect(expectOk('a' + U(0x200e) + 'b').name).toBe('ab');
  });

  it('strips before normalizing, so a split accent still composes', () => {
    // Leave the ZWSP in place and NFC cannot join the two halves.
    expect(expectOk('a' + ZWSP + COMBINING_ACUTE).name).toBe(U(0x00e1));
  });

  it('strips the whole non-orthographic family, not just the famous members', () => {
    // WORD JOINER is the modern replacement for U+FEFF-as-ZWNBSP: stripping one
    // and not the other leaves the identical hole under a different code point.
    // Anyone could mint a second `design` tag that renders the same in every
    // chip, and Phase 2 is about to bake that key into a unique index.
    expect(expectOk('de' + U(0x2060) + 'sign').key).toBe(expectOk('design').key);

    for (const cp of [0x2060, 0x2061, 0x2064, 0x034f, 0x180e, 0xfff9, 0x1d173]) {
      expect(expectOk('a' + U(cp) + 'b').name, `U+${cp.toString(16)}`).toBe('ab');
    }
  });

  it('refuses a name that renders as nothing, however many code points it has', () => {
    // Neither stripped nor collapsed, and each a different code point — so
    // several distinct blank tags could coexist, and nobody could retype,
    // search for, or tell them apart. The Hangul fillers and the Braille blank
    // are the classic version of this trick.
    for (const cp of [0x200c, 0x200d, 0xfe0f, 0xfe0e, 0xe0100, 0xe01ef, 0x3164, 0x2800, 0x115f, 0x1160, 0xffa0, 0xe0061]) {
      expect(normalizeTagName(U(cp)), `U+${cp.toString(16)}`).toEqual({
        ok: false,
        reason: 'empty',
      });
    }
    // One visible character is enough to make it a name again.
    expect(expectOk('a' + U(0x200d) + 'b').name).toBe('a' + U(0x200d) + 'b');
    expect(expectOk(U(0x2800) + 'x').name).toBe(U(0x2800) + 'x');
  });

  it('KEEPS the joiners, which are meaning rather than noise', () => {
    // Stripping ZWJ turns one family into three separate people.
    const family = expectOk(FAMILY);
    expect(family.name).toBe(FAMILY);
    expect([...family.name]).toHaveLength(5);

    // ZWNJ is required orthography in Persian; the two spellings are different
    // words, so they are deliberately two tags.
    const withZwnj = expectOk(U(0x0645, 0x06cc) + ZWNJ + U(0x0631, 0x0648, 0x062f));
    const without = expectOk(U(0x0645, 0x06cc, 0x0631, 0x0648, 0x062f));
    expect(withZwnj.name).toContain(ZWNJ);
    expect(withZwnj.key).not.toBe(without.key);
  });

  it('keeps a variation selector, which decides emoji versus text presentation', () => {
    expect(expectOk(U(0x2764) + U(0xfe0f)).name).toBe(U(0x2764) + U(0xfe0f));
  });

  it('rejects a name made only of strippable invisibles', () => {
    expect(normalizeTagName(ZWSP + BOM + SHY)).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('normalizeTagName — whitespace', () => {
  it('collapses runs to one space and trims the ends', () => {
    expect(expectOk('  Design   System  ').name).toBe('Design System');
    expect(expectOk('a\nb').name).toBe('a b');
    expect(expectOk('a\tb').name).toBe('a b');
  });

  it('collapses the Unicode spaces too, unlike the Phase 0 projection set', () => {
    // A tag name is an identifier a human retypes, so invisible variation in
    // the middle of one is a defect. text-projection.ts deliberately does the
    // opposite for prose, where those characters are content.
    for (const space of [NBSP, EM_SPACE, IDEOGRAPHIC_SPACE, OGHAM_SPACE, U(0x202f)]) {
      expect(expectOk('a' + space + 'b').name).toBe('a b');
    }
  });

  it('keeps the name and key paths agreeing about what a space is', () => {
    // If they disagreed, a name could survive that the key trims to empty —
    // and an empty key is a row that collides with nothing under the unique
    // index it is about to be stored in.
    for (const space of [NBSP, EM_SPACE, IDEOGRAPHIC_SPACE, OGHAM_SPACE]) {
      const spaced = expectOk('a' + space + 'b');
      expect(spaced.key).toBe('a b');
      expect(normalizeTagName(space)).toEqual({ ok: false, reason: 'empty' });
    }
  });

  it('rejects blank input', () => {
    expect(normalizeTagName('')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeTagName('   ')).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('normalizeTagName — characters that cannot be stored at all', () => {
  it('rejects NUL and the other controls rather than stripping them', () => {
    // Postgres refuses NUL in a text column outright, so stripping would mean
    // this core says "fine" and the INSERT fails later.
    expect(normalizeTagName('a' + U(0) + 'b')).toEqual({
      ok: false,
      reason: 'control_character',
      codePoint: 0,
      index: 1,
    });
    expect(normalizeTagName('a' + U(0x07) + 'b')).toMatchObject({ reason: 'control_character' });
    expect(normalizeTagName('a' + U(0x7f) + 'b')).toMatchObject({ reason: 'control_character' });
    expect(normalizeTagName('a' + U(0x9f) + 'b')).toMatchObject({ reason: 'control_character' });
  });

  it('splits the whole control range into collapse-or-reject with no gaps', () => {
    // The collapsible controls are named twice in the module — once as code
    // points, once inside the whitespace regex — so this walks every C0/C1
    // code point and asserts the two agree. Any drift between them shows up
    // here rather than as a tag that mysteriously will not save.
    const COLLAPSIBLE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x85]);
    const controls = [
      ...Array.from({ length: 0x20 }, (_unused, cp) => cp),
      ...Array.from({ length: 0x21 }, (_unused, offset) => 0x7f + offset),
    ];

    for (const cp of controls) {
      const result = normalizeTagName('a' + U(cp) + 'b');
      if (COLLAPSIBLE.has(cp)) {
        expect(result, `U+${cp.toString(16)} should collapse`).toMatchObject({
          ok: true,
          name: 'a b',
        });
      } else {
        expect(result, `U+${cp.toString(16)} should be refused`).toMatchObject({
          reason: 'control_character',
          codePoint: cp,
        });
      }
    }
  });

  it('rejects a lone surrogate, which is not encodable as UTF-8', () => {
    expect(normalizeTagName('a' + String.fromCharCode(0xd800) + 'b')).toEqual({
      ok: false,
      reason: 'unpaired_surrogate',
      index: 1,
    });
    expect(normalizeTagName('a' + String.fromCharCode(0xdc00))).toEqual({
      ok: false,
      reason: 'unpaired_surrogate',
      index: 1,
    });
    // A high surrogate at the very END of the input has no following unit at
    // all, which is a different code path from one followed by a non-surrogate.
    expect(normalizeTagName('a' + String.fromCharCode(0xd800))).toEqual({
      ok: false,
      reason: 'unpaired_surrogate',
      index: 1,
    });
    // A well-formed pair is not a lone surrogate and must survive.
    expect(expectOk(U(0x1f600)).name).toBe(U(0x1f600));
  });

  it('rejects noncharacters, in both the BMP and the astral planes', () => {
    expect(normalizeTagName('a' + U(0xfffe) + 'b')).toMatchObject({ reason: 'noncharacter' });
    expect(normalizeTagName('a' + U(0xfdd0) + 'b')).toMatchObject({ reason: 'noncharacter' });
    expect(normalizeTagName('a' + U(0x1fffe) + 'b')).toMatchObject({ reason: 'noncharacter' });
  });

  it('reports the first offence in order, so the reason is deterministic', () => {
    const both = normalizeTagName('a' + U(0) + String.fromCharCode(0xd800));
    expect(both).toEqual({ ok: false, reason: 'control_character', codePoint: 0, index: 1 });
  });
});

describe('normalizeTagName — length', () => {
  it('measures code points, so no script is charged more than another', () => {
    expect(expectOk('x'.repeat(MAX_TAG_NAME_LENGTH)).name).toHaveLength(MAX_TAG_NAME_LENGTH);
    expect(expectOk(U(0x65e5).repeat(MAX_TAG_NAME_LENGTH)).name).toBeTruthy();
    expect(normalizeTagName('x'.repeat(MAX_TAG_NAME_LENGTH + 1))).toEqual({
      ok: false,
      reason: 'too_long',
      length: MAX_TAG_NAME_LENGTH + 1,
      max: MAX_TAG_NAME_LENGTH,
    });
  });

  it('counts an astral character once, not twice', () => {
    // Guards against a regression to string.length: 64 emoji are 128 UTF-16
    // units and would be rejected under the wrong unit.
    expect(expectOk(U(0x1f600).repeat(MAX_TAG_NAME_LENGTH)).name).toBeTruthy();
  });

  it('measures after normalization, so a decomposed name is not penalised', () => {
    // 64 decomposed accents are 128 code points raw and 64 once composed.
    expect(expectOk(('e' + COMBINING_ACUTE).repeat(MAX_TAG_NAME_LENGTH)).name).toHaveLength(
      MAX_TAG_NAME_LENGTH
    );
  });

  it('publishes the real key ceiling, which is not the name ceiling', () => {
    // NFKC expands. Measured exhaustively over all 1.1M code points, the worst
    // single character is U+FDFA at 18, so a 64-code-point name can key to
    // 1152. Phase 2 sizes normalizedKey from this constant; the obvious
    // varchar(64) mirroring the name limit would reject a legal tag at INSERT.
    const worst = expectOk(U(0xfdfa).repeat(MAX_TAG_NAME_LENGTH));
    expect([...worst.name]).toHaveLength(MAX_TAG_NAME_LENGTH);
    expect([...worst.key]).toHaveLength(MAX_TAG_KEY_LENGTH);
    expect(MAX_TAG_KEY_LENGTH).toBeGreaterThan(MAX_TAG_NAME_LENGTH);
    // And it must still fit a btree index tuple, which caps around 2704 bytes.
    expect(new TextEncoder().encode(worst.key).length).toBeLessThan(2704);
  });

  it('never produces a key longer than the published ceiling', () => {
    const samples = [
      'x'.repeat(MAX_TAG_NAME_LENGTH),
      U(0xfdfa).repeat(MAX_TAG_NAME_LENGTH),
      U(0x2121).repeat(MAX_TAG_NAME_LENGTH),
      U(0x33a1).repeat(MAX_TAG_NAME_LENGTH),
      U(0x1f600).repeat(MAX_TAG_NAME_LENGTH),
    ];
    for (const sample of samples) {
      const { key } = expectOk(sample);
      expect([...key].length, JSON.stringify(sample.slice(0, 8))).toBeLessThanOrEqual(
        MAX_TAG_KEY_LENGTH
      );
    }
  });

  it('guards the raw input before doing any Unicode work', () => {
    const huge = 'x'.repeat(MAX_RAW_TAG_INPUT + 1);
    expect(normalizeTagName(huge)).toEqual({
      ok: false,
      reason: 'input_too_large',
      length: MAX_RAW_TAG_INPUT + 1,
    });
    // A whole document must be refused cheaply rather than normalized first.
    expect(normalizeTagName('x'.repeat(500_000))).toMatchObject({ reason: 'input_too_large' });
  });
});

describe('tagKey and idempotency', () => {
  const CORPUS = [
    'Caf' + E_ACUTE,
    'cafe' + COMBINING_ACUTE,
    '  Design   System  ',
    U(0x65e5, 0x672c, 0x8a9e),
    U(0xff26, 0xff55, 0xff4c, 0xff4c),
    U(0x2121),
    U(0x33a1),
    U(0x39f, 0x394, 0x39f, 0x3a3),
    'a' + ZWSP + 'b',
    FAMILY,
    'a' + IDEOGRAPHIC_SPACE + 'b',
    U(0x00b4),
    U(0xfdfa),
    'H' + U(0x0331),
  ];

  it('is the key of the name, so a backfill can recompute it from storage', () => {
    for (const raw of CORPUS) {
      const { name, key } = expectOk(raw);
      expect(tagKey(name), `tagKey mismatch for ${JSON.stringify(raw)}`).toBe(key);
    }
  });

  it('is idempotent — re-normalizing a name changes nothing', () => {
    for (const raw of CORPUS) {
      const first = expectOk(raw);
      const second = expectOk(first.name);
      expect(second.name, `not idempotent for ${JSON.stringify(raw)}`).toBe(first.name);
      expect(second.key).toBe(first.key);
    }
  });

  it('is idempotent for the cases that catch a reordering refactor', () => {
    // Collapse-before-normalize would leave two spaces here on the first pass
    // and one on the second.
    const doubled = expectOk('a' + IDEOGRAPHIC_SPACE + IDEOGRAPHIC_SPACE + 'b');
    expect(doubled.name).toBe('a b');
    expect(expectOk(doubled.name).name).toBe('a b');

    // Fold-before-NFKC would produce an uppercase key on the first pass.
    expect(tagKey(tagKey(U(0x2121)))).toBe(tagKey(U(0x2121)));
  });

  it('re-normalizes after folding, or a composed lowercase form splits the tag', () => {
    // toLowerCase does not promise to preserve normal form. 'H' followed by a
    // combining macron below lowercases to the DECOMPOSED pair h + U+0331,
    // whereas the same word typed in lowercase is composed to U+1E96 by NFC on
    // the name path. Without a second NFKC after the fold those are two
    // different keys for one word — a silent duplicate tag.
    const MACRON_BELOW = U(0x0331);
    const upper = expectOk('H' + MACRON_BELOW);
    const lower = expectOk('h' + MACRON_BELOW);

    expect(upper.key).toBe(lower.key);
    expect(upper.key).toBe(U(0x1e96));
  });

  it('produces a key that is itself NFKC-stable', () => {
    for (const raw of CORPUS) {
      const { key } = expectOk(raw);
      expect(key.normalize('NFKC')).toBe(key);
    }
  });
});

describe('TAG_TARGETS', () => {
  it('covers exactly the live page types', () => {
    expect(Object.keys(TAG_TARGETS).sort()).toEqual([...PAGE_TYPE_VALUES].sort());
  });

  it('lets every page type carry a page-level tag', () => {
    for (const pageType of PAGE_TYPE_VALUES) {
      expect(TAG_TARGETS[pageType], pageType).toContain('page');
    }
  });

  it('grants an anchored kind exactly where the version chain exists', () => {
    // Forward-porting is the primary anchoring mechanism and it needs
    // page_versions rows, so a page type that cannot version cannot carry an
    // anchored tag. Ties this registry to PAGE_TYPE_CONFIGS so the two cannot
    // drift apart silently.
    for (const pageType of PAGE_TYPE_VALUES) {
      const kinds: readonly TargetKind[] = TAG_TARGETS[pageType];
      const anchored = kinds.includes('text') || kinds.includes('sheet_cell');
      expect(anchored, pageType).toBe(PAGE_TYPE_CONFIGS[pageType].capabilities.supportsVersioning);
    }
  });

  it('gives each page type at most one content-level kind', () => {
    for (const pageType of PAGE_TYPE_VALUES) {
      const kinds: readonly TargetKind[] = TAG_TARGETS[pageType];
      expect(kinds.filter((kind) => kind !== 'page').length, pageType).toBeLessThanOrEqual(1);
    }
  });

  it('routes the row-identified kinds to the page types that own those rows', () => {
    expect(TAG_TARGETS.CHANNEL).toContain('channel_message');
    expect(TAG_TARGETS.AI_CHAT).toContain('ai_message');
    expect(TAG_TARGETS.SHEET).toContain('sheet_cell');
    // A task IS a page, so TASK_LIST needs no kind of its own.
    expect(TAG_TARGETS.TASK_LIST).toEqual(['page']);
  });
});

describe('validateTarget', () => {
  const anchor: TextAnchor = {
    v: 1,
    exact: 'quoted',
    prefix: '',
    suffix: '',
    start: 0,
    end: 6,
    revision: 1,
    textHash: 'deadbeefdeadbeef',
  };
  const cell: SheetCellAnchor = { v: 1, sheet: 'Sheet1', address: 'A1' };

  const sample = (kind: TargetKind): TagTarget => {
    switch (kind) {
      case 'page':
        return { kind: 'page' };
      case 'text':
        return { kind: 'text', anchor };
      case 'sheet_cell':
        return { kind: 'sheet_cell', anchor: cell };
      case 'channel_message':
        return { kind: 'channel_message', channelMessageId: 'cm_1' };
      case 'ai_message':
        return { kind: 'ai_message', aiMessageId: 'am_1' };
    }
  };

  const ALL_KINDS: readonly TargetKind[] = [
    'page',
    'text',
    'sheet_cell',
    'channel_message',
    'ai_message',
  ];

  it('accepts exactly the pairs TAG_TARGETS allows, across all 45 combinations', () => {
    for (const pageType of PAGE_TYPE_VALUES) {
      for (const kind of ALL_KINDS) {
        const allowed: readonly TargetKind[] = TAG_TARGETS[pageType];
        const result = validateTarget(pageType, sample(kind));
        expect(result.ok, `${pageType} + ${kind}`).toBe(allowed.includes(kind));
        if (!result.ok) {
          expect(result).toEqual({ ok: false, reason: 'kind_not_allowed', pageType, kind });
        }
      }
    }
  });

  it('rejects a payload that does not match the kind it claims', () => {
    expect(validateTarget('CHANNEL', { kind: 'channel_message', channelMessageId: '' })).toMatchObject(
      { reason: 'payload_mismatch', kind: 'channel_message' }
    );
    expect(validateTarget('AI_CHAT', { kind: 'ai_message', aiMessageId: '' })).toMatchObject({
      reason: 'payload_mismatch',
      kind: 'ai_message',
    });
    // Both halves of the (sheet name, A1 address) natural key, and the address
    // has to be an actual A1 reference — merely non-empty still points nowhere.
    expect(
      validateTarget('SHEET', { kind: 'sheet_cell', anchor: { v: 1, sheet: 'S', address: '' } })
    ).toMatchObject({ reason: 'payload_mismatch', kind: 'sheet_cell' });
    expect(
      validateTarget('SHEET', { kind: 'sheet_cell', anchor: { v: 1, sheet: '', address: 'A1' } })
    ).toMatchObject({ reason: 'payload_mismatch', detail: 'sheet name is empty' });
    expect(
      validateTarget('SHEET', { kind: 'sheet_cell', anchor: { v: 1, sheet: 'S', address: 'banana' } })
    ).toMatchObject({ reason: 'payload_mismatch', kind: 'sheet_cell' });
    // A real address is accepted, in either case.
    expect(validateTarget('SHEET', { kind: 'sheet_cell', anchor: { v: 1, sheet: 'S', address: 'B12' } })).toEqual({ ok: true });
    expect(validateTarget('SHEET', { kind: 'sheet_cell', anchor: { v: 1, sheet: 'S', address: 'aa10' } })).toEqual({ ok: true });
  });

  it('refuses an unknown page type instead of throwing', () => {
    // The signature is a compile-time promise only. MACHINE is the concrete
    // case: it is still a value in the DB's PageType enum, deleted from the TS
    // enum in the Phase 8 teardown because Postgres cannot DROP VALUE — so a
    // pages.type this function is typed to never see can arrive from a row.
    const unknown = 'MACHINE' as PageTypeValue;
    expect(validateTarget(unknown, { kind: 'page' })).toEqual({
      ok: false,
      reason: 'unknown_page_type',
      pageType: 'MACHINE',
    });
  });

  it('refuses an inherited Object property rather than treating it as a registry entry', () => {
    // A bare index reaches the prototype: TAG_TARGETS['constructor'] is a
    // function, not undefined, so a falsy guard would wave it through and the
    // membership test would throw. Same shape as the &__proto__; entity bug in
    // Phase 0 — hence the Set.
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(validateTarget(inherited as PageTypeValue, { kind: 'page' })).toEqual({
        ok: false,
        reason: 'unknown_page_type',
        pageType: inherited,
      });
    }
  });

  it('checks the page type before the payload', () => {
    // An empty id on a page type that rejects the kind outright reports the
    // rejection the user can act on, not the one they cannot.
    expect(validateTarget('FOLDER', { kind: 'channel_message', channelMessageId: '' })).toMatchObject(
      { reason: 'kind_not_allowed' }
    );
  });
});

/**
 * The hazards in this module are lexical — a locale-aware fold, an ICU-backed
 * API, a Unicode property escape — so they are asserted over the source text,
 * mirroring content/anchoring/__tests__/purity.test.ts.
 */
describe('tag-core purity and determinism', () => {
  const src = readFileSync(fileURLToPath(new URL('../tag-core.ts', import.meta.url)), 'utf8');

  /**
   * Comments stripped: these bans are on CODE. The module documents at length
   * why it does not call toLocaleLowerCase, and prose explaining a prohibition
   * must not trip it — otherwise the only way to keep the test green is to stop
   * writing down the reason, which is the opposite of what we want.
   */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('does no I/O and reads no ambient state', () => {
    expect(src).not.toMatch(/from ['"][^'"]*\/db['"]/);
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/Date\.now/);
    expect(src).not.toMatch(/new Date\(/);
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/\bwindow\./);
    expect(src).not.toMatch(/\bglobalThis\./);
  });

  it('imports nothing outside this package', () => {
    const specifiers = [...code.matchAll(/^import[^'"]*from ['"]([^'"]+)['"];?$/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier.startsWith('.'), `unexpected import: ${specifier}`).toBe(true);
    }
  });

  it('never reaches for a locale-dependent or ICU-versioned API', () => {
    // toLocaleLowerCase keys 'IT' differently on a Turkish host. Intl.Segmenter
    // would make a length depend on the runtime's ICU build. A Unicode property
    // escape moves as new code points are assigned. All three would break the
    // rule that this must produce identical output on server and client.
    expect(code).not.toMatch(/toLocaleLowerCase/);
    expect(code).not.toMatch(/toLocaleUpperCase/);
    expect(code).not.toMatch(/\bIntl\./);
    expect(code).not.toMatch(/\\p\{/);
  });

  it('keeps both normal forms, so a simplification cannot unify them', () => {
    expect(code).toMatch(/normalize\('NFC'\)/);
    expect(code).toMatch(/normalize\('NFKC'\)/);
  });

  it('writes every invisible character as an escape rather than a literal', () => {
    // A literal invisible in this file would be unreviewable in a diff — the
    // exact property the module exists to prevent in tag names.
    const literals = [...src].filter((char) => {
      const cp = char.codePointAt(0) ?? 0;
      return (
        (cp < 0x20 && char !== '\n') ||
        cp === 0x7f ||
        cp === 0x00ad ||
        cp === 0x200b ||
        cp === 0xfeff ||
        (cp >= 0x202a && cp <= 0x202e)
      );
    });
    expect(literals).toEqual([]);
  });
});
