/**
 * Pure vocabulary core for content tags: what a tag NAME is, and which kinds of
 * thing each page type can carry a tag on. Zero I/O — no db, no fetch, no
 * clock, no env — enforced by the purity test in __tests__/tag-core.test.ts.
 * The service shell (a later phase) owns every side effect.
 *
 * Both rules live here because Phase 2 is about to make them permanent:
 * `UNIQUE (driveId, normalizedKey)` bakes the dedupe rule into an index, and
 * the `content_tags` CHECK constraint is effectively one-way in this repo's
 * migration conventions. Reviewing them as plain functions first is cheaper
 * than getting them back out of an index later.
 *
 * Every invisible character below is written as an escape sequence on purpose.
 * A literal one is unreadable in a diff and unreviewable in a code review,
 * which is exactly the wrong property for the characters this module exists to
 * police.
 *
 * @module @pagespace/lib/tags/tag-core
 */

import { isValidCellAddress } from '../sheets/address';
import type { SheetCellAnchor, TextAnchor } from '../content/anchoring/types';
import type { PageTypeValue } from '../utils/enums';
import type { ContentTagTargetKind } from '@pagespace/db/schema/content-tags';

/** Max code points in a tag's display name, after normalization. */
export const MAX_TAG_NAME_LENGTH = 64;

/**
 * Runaway guard on the raw input, in UTF-16 code units, checked before any
 * allocation — `raw.length` is O(1), which is the point of doing it first.
 *
 * A valid name is at most 64 code points, so at most 128 code units. The only
 * way past 512 is mass whitespace or a paste of something that was never a
 * name, so this bounds both the scan and the `normalize()` allocation against a
 * caller who hands over a whole document.
 */
export const MAX_RAW_TAG_INPUT = 512;

/**
 * The longest key a valid name can produce, for whoever sizes the column.
 *
 * MAX_TAG_NAME_LENGTH bounds the NAME; the key is derived through NFKC, which
 * expands. Measured exhaustively over all 1.1M code points, the worst single
 * character is U+FDFA (an Arabic ligature) at 18 code points, so the ceiling is
 * 64 x 18 = 1152 code points, or 2112 bytes of UTF-8.
 *
 * Exported because Phase 2 chooses `normalizedKey`'s type from these constants,
 * and the obvious `varchar(64)` mirroring the name limit would reject a legal
 * tag at INSERT time — the exact failure mode this module refuses characters to
 * avoid. It fits under Postgres's ~2704-byte btree tuple limit, so the unique
 * index is safe, but not with much room to spare.
 */
export const MAX_TAG_KEY_LENGTH = MAX_TAG_NAME_LENGTH * 18;

/**
 * Why a name was refused. A discriminated union rather than a boolean or a
 * throw, following workspace-node-validate.ts: the server turns a rejection
 * into an HTTP error and the client renders it, and neither can parse prose.
 *
 * `index` is a UTF-16 offset deliberately — that is the unit a text input's
 * selection API and `String.prototype.slice` use, so a UI can point at the
 * offending character.
 */
export type TagNameRejection =
  /** Nothing survived normalization — blank, or invisible characters only. */
  | { ok: false; reason: 'empty' }
  /** The runaway guard tripped before normalizing. `length` is UTF-16 units. */
  | { ok: false; reason: 'input_too_large'; length: number }
  /** The normalized name is over the limit. `length` is code points. */
  | { ok: false; reason: 'too_long'; length: number; max: number }
  /** A C0/C1 control or DEL. */
  | { ok: false; reason: 'control_character'; codePoint: number; index: number }
  /** A lone surrogate: not encodable as UTF-8, so not storable at all. */
  | { ok: false; reason: 'unpaired_surrogate'; index: number }
  /** U+FDD0-U+FDEF or U+xFFFE/U+xFFFF — internal-use sentinels. */
  | { ok: false; reason: 'noncharacter'; codePoint: number; index: number };

export type TagNameResult = { ok: true; name: string; key: string } | TagNameRejection;

/**
 * Characters that are invisible and carry no orthographic role anywhere: soft
 * hyphen, zero-width space, the bidi marks, the bidi embeddings, overrides and
 * isolates, and the byte-order mark.
 *
 * Stripped rather than kept because NFKC leaves every one of them alone, so two
 * tags could look identical and be two distinct rows — a dedupe hole, and in
 * the case of the bidi overrides the entire text-spoofing surface.
 *
 * NOT stripped, and this is the part that matters: U+200C ZWNJ, U+200D ZWJ, the
 * variation selectors and the tag characters. Those are meaningful. ZWJ is what
 * joins the man/woman/girl emoji into ONE family glyph rather than three
 * separate people; ZWNJ is required orthography in Persian and in Indic
 * scripts; VS16 is the difference between the red heart emoji and the black
 * text heart; the tag characters encode the subdivision flags such as Scotland.
 * The obvious implementation — strip everything Default_Ignorable — mangles all
 * four, and its membership tracks the engine's ICU version besides.
 *
 * The list covers the whole non-orthographic family, not just the famous
 * members: WORD JOINER U+2060 is the modern replacement for U+FEFF-as-ZWNBSP
 * and would otherwise be the same hole with a different code point, and the
 * invisible math operators, CGJ, the interlinear annotation marks and the
 * musical format controls are all equally unrenderable and equally usable to
 * mint a duplicate tag that looks identical in every chip and autocomplete.
 *
 * The set is derived rather than remembered. Three review rounds each found a
 * different missing code point, which is a sign the list was being maintained
 * by memory — so it is now the WHOLE Default_Ignorable class minus an explicit,
 * justified keep-list, and a test sweeps every code point in that class and
 * fails on anything unaccounted for. Deprecated format characters, the Khmer
 * inherent vowels, the shorthand format controls and the unassigned ignorable
 * blocks all arrived that way.
 *
 * Stripped rather than merely treated as blank, because blank-counting refuses
 * a name made ONLY of them while still letting `a<U+E0001>b` key differently
 * from `ab` — which leaves the dedupe hole, the more damaging half. The real
 * tag characters at U+E0020-E007F stay, since they encode the subdivision
 * flags.
 *
 * Enumerated literally rather than by Unicode property: a property escape's
 * membership tracks the engine's ICU build, which would make the key depend on
 * which runtime computed it.
 */
const INVISIBLE_FORMATTING =
  /[\u00ad\u034f\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2065\u206a-\u206f\u17b4-\u17b5\u2066-\u2069\ufeff\ufff0-\ufffb\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e001f}\u{e0080}-\u{e00ff}\u{e01f0}-\u{e0fff}]/gu;

/**
 * Whitespace collapsed to a single space. Deliberately WIDER than
 * `COLLAPSIBLE_WHITESPACE` in content/anchoring/text-projection.ts, which folds
 * only space, tab, the line breaks and NBSP.
 *
 * That module argued EM SPACE is content, because folding it makes a quote
 * unfindable in the prose it was taken from. The argument is about
 * offset-preserving projection and does not transfer here: a tag name is an
 * identifier a human retypes, and an EM SPACE inside one is invisible variation
 * nobody can see or reproduce. NFKC already folds most of these on the key
 * path, so widening the name path is mostly about making the two paths agree.
 *
 * Enumerated rather than a Unicode property escape — same ICU-version reason.
 */
const COLLAPSIBLE_WHITESPACE =
  /[ \t\n\v\f\r\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;

/** Greek FINAL sigma, folded to the medial form so one word is one tag. */
const FINAL_SIGMA = /\u03c2/g;
const MEDIAL_SIGMA = '\u03c3';

/**
 * Matches a value in which nothing renders — including the empty string, which
 * is why this subsumes a length check rather than sitting beside one.
 *
 * A plain space is in the class, and it is load-bearing rather than tidy. The
 * name is collapsed and trimmed before this runs, so U+0020 is the only
 * whitespace that can still be present — and without it, one blank renderer is
 * refused while two separated by a space are not. That name is non-empty, its
 * key folds to nothing, and every such tag then collides on the empty key under
 * UNIQUE (driveId, normalizedKey): one row occupies it and blocks the rest.
 *
 * Every code point INVISIBLE_FORMATTING keeps must appear here, and a test
 * derives its cases from that keep-list rather than restating it — the two
 * drifted apart once already, over the Mongolian free variation selectors.
 *
 * Two groups of code points. The joiners and selectors are KEPT deliberately
 * (see INVISIBLE_FORMATTING) because they are meaningful NEXT TO other
 * characters — but a name made only of them is not a name. The Hangul fillers
 * and the Braille blank are the classic blank-name trick: ordinary letters by
 * category, blank on screen, and each a different code point, so several
 * distinct blank tags could coexist with nobody able to retype, search for, or
 * tell them apart.
 *
 * A denylist rather than a Unicode property test, and therefore best-effort:
 * property membership moves with the engine's ICU build, which the whole module
 * is built to avoid.
 */
/**
 * Blank but SPACE-LIKE: the Hangul fillers and the Braille blank cell occupy a
 * character's width and render as a gap, unlike the zero-width family above.
 *
 * Folded to a space in the KEY, kept verbatim in the NAME. Both halves of that
 * matter, and getting either wrong opens a dedupe hole in one direction:
 *
 *   - Keeping them as themselves splits `admin` from `admin<U+FFA0>`, which
 *     render identically. That is the hole INVISIBLE_FORMATTING's docstring
 *     calls "the more damaging half".
 *   - Deleting them outright splits `a b` from `a<U+3164>b`, which ALSO render
 *     identically — the same hole mirrored, and the one an earlier version of
 *     this constant introduced while closing the first.
 *
 * Folding to a space closes both: the trailing case trims away, and the
 * interior case collapses into the ordinary space it looks like.
 *
 * Deliberately NOT the joiners or the variation selectors, which render as
 * nothing alone but change how their NEIGHBOURS render — folding those would
 * key the family emoji the same as three separate people.
 */
const BLANK_IN_KEY = /[\u115f\u1160\u3164\uffa0\u2800]/g;

const NOTHING_VISIBLE =
  /^[ \u180b-\u180d\u180f\u200c\u200d\u115f\u1160\u3164\uffa0\u2800\ufe00-\ufe0f\u{e0020}-\u{e007f}\u{e0100}-\u{e01ef}]*$/u;

/** The collapsible characters that are also C0/C1 — whitespace, not damage. */
const COLLAPSIBLE_CONTROLS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x85]);

function isNoncharacter(codePoint: number): boolean {
  if (codePoint >= 0xfdd0 && codePoint <= 0xfdef) {
    return true;
  }
  return (codePoint & 0xfffe) === 0xfffe;
}

function isControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

/**
 * Scan for characters that must be refused rather than cleaned up, returning
 * the first offence in code-point order so the reported reason is deterministic
 * rather than an artefact of check order.
 *
 * Refused rather than stripped for one concrete reason: Postgres stores none of
 * them in a `text` column. NUL is rejected outright by the driver and a lone
 * surrogate is not encodable as UTF-8, so stripping would mean this pure core
 * says "fine" and the INSERT fails later. Silently storing a different name
 * than the one submitted is the worse failure anyway. Phase 0 refuses to decode
 * surrogates in `decodeEntity` for exactly this reason.
 */
function findRefusedCharacter(raw: string): TagNameRejection | null {
  for (let index = 0; index < raw.length; index += 1) {
    const unit = raw.charCodeAt(index);

    if (unit >= 0xd800 && unit <= 0xdbff) {
      // charCodeAt past the end returns NaN, and NaN fails every comparison, so
      // a high surrogate at the very end of the input falls into this branch
      // without needing a length check of its own.
      const next = raw.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return { ok: false, reason: 'unpaired_surrogate', index };
      }
      // Combine the pair arithmetically rather than via codePointAt, which
      // would need an `?? 0` fallback for a case the branch above already ruled
      // out — a dead branch is worse than the four lines of arithmetic.
      const codePoint = (unit - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
      if (isNoncharacter(codePoint)) {
        return { ok: false, reason: 'noncharacter', codePoint, index };
      }
      index += 1;
      continue;
    }

    if (unit >= 0xdc00 && unit <= 0xdfff) {
      return { ok: false, reason: 'unpaired_surrogate', index };
    }

    if (isNoncharacter(unit)) {
      return { ok: false, reason: 'noncharacter', codePoint: unit, index };
    }

    if (isControl(unit) && !COLLAPSIBLE_CONTROLS.has(unit)) {
      return { ok: false, reason: 'control_character', codePoint: unit, index };
    }
  }

  return null;
}

function collapse(value: string): string {
  return value.replace(COLLAPSIBLE_WHITESPACE, ' ').trim();
}

/**
 * The dedupe key for an ALREADY-normalized name — the value
 * `UNIQUE (driveId, normalizedKey)` is taken on.
 *
 * Exported, and defined as a function of `name` rather than of the raw input,
 * so a backfill can recompute every key from the stored name and provably get
 * the same value back.
 *
 * Three details are load-bearing:
 *
 * - **NFKC before the fold, and again after.** Lowercasing the TELEPHONE SIGN
 *   leaves it unchanged, and NFKC then turns it into the UPPERCASE `TEL`;
 *   folding after NFKC gives `tel`. The trailing pass makes "the key is
 *   NFKC-stable" a theorem rather than an observation, since `toLowerCase` does
 *   not promise to preserve normal form (U+0130 lowercases to `i` + U+0307).
 * - **`toLowerCase`, never `toLocaleLowerCase`.** Without an explicit locale
 *   the latter uses the HOST locale, so a Turkish machine keys `IT` as a
 *   dotless-i form and cannot see the row it should have deduped against. That
 *   is Phase 0's determinism bug in new clothes, and this one lands inside a
 *   unique index.
 * - **Final sigma.** JS implements Unicode's Final_Sigma rule, so an uppercase
 *   Greek word lowercases with a FINAL sigma U+03C2 while someone typing the
 *   medial form gets U+03C3 — two tags for one word. Folding them is what true
 *   case folding does; one `replace` buys it.
 */
export function tagKey(name: string): string {
  // Strips the invisibles again even though a normalized name has none left.
  // It is idempotent there, and it stops the obvious next-phase use — keying a
  // raw search string to find an existing tag — from silently producing a key
  // no stored row can carry, where one pasted zero-width space misses the row
  // and drives a duplicate insert.
  const stripped = name.replace(INVISIBLE_FORMATTING, '').replace(BLANK_IN_KEY, ' ');
  const folded = stripped.normalize('NFKC').toLowerCase().replace(FINAL_SIGMA, MEDIAL_SIGMA);
  return collapse(folded.normalize('NFKC'));
}

/**
 * Normalize a user-supplied tag name into the stored display `name` and the
 * `key` it dedupes on. Total: never throws, for any string.
 *
 * `name` is NFC and `key` is NFKC, deliberately different forms. NFKC folds
 * compatibility variants, which is exactly what a dedupe key wants — it is what
 * makes a mathematical-script `Cool` and a plain `Cool` the same tag — and
 * exactly what a display name must not do: it turns the square-metre sign into
 * `m2`, a superscript two into a plain `2`, and an acute accent into a space
 * followed by an orphaned combining mark. Using it for `name` would silently
 * rewrite what the user typed. This is the casing rule applied one axis
 * further: the first writer's form wins, and the key is what collapses.
 *
 * Known limits, documented rather than papered over, because JS has no true
 * case folding. German sharp-s and a doubled S do NOT dedupe — folding them
 * would also merge two different German words (measures and mass), so not
 * folding is the more correct behaviour. Neither do the Turkish dotted-I
 * forms: Unicode's default folding gives `i` + U+0307 as well, and only the
 * Turkish tailoring merges them, which is the non-deterministic path.
 */
export function normalizeTagName(raw: string): TagNameResult {
  if (raw.length > MAX_RAW_TAG_INPUT) {
    return { ok: false, reason: 'input_too_large', length: raw.length };
  }

  const refused = findRefusedCharacter(raw);
  if (refused) {
    return refused;
  }

  // Strip before normalizing: an "a", a zero-width space and a combining acute
  // must compose to a-acute, which cannot happen while the ZWSP sits between.
  const name = collapse(raw.replace(INVISIBLE_FORMATTING, '').normalize('NFC'));

  // 'empty' means nothing a reader can SEE, not merely a zero-length string: a
  // chip that renders blank is unusable however many code points back it.
  if (NOTHING_VISIBLE.test(name)) {
    return { ok: false, reason: 'empty' };
  }

  const length = [...name].length;
  if (length > MAX_TAG_NAME_LENGTH) {
    return { ok: false, reason: 'too_long', length, max: MAX_TAG_NAME_LENGTH };
  }

  return { ok: true, name, key: tagKey(name) };
}

/**
 * What a tag can be attached to — DERIVED from the `ContentTagTargetKind`
 * pgEnum in `packages/db/src/schema/content-tags.ts`, which is the one
 * canonical declaration of the variant set.
 *
 * Derived rather than restated because the dependency runs `lib -> db` and
 * never the reverse, so `db` is the only side that can be the source. Two
 * parallel unions kept in step by a drift test is strictly worse than a
 * structure in which drift cannot exist — and both directions of drift are
 * compile errors, verified by mutating the pgEnum and watching them:
 *
 *   - REMOVING or renaming a value breaks THIS FILE: `TAG_TARGETS` lists the
 *     kinds as literals under a `satisfies Record<..., readonly TargetKind[]>`,
 *     and `validateTarget` compares `target.kind` against them.
 *   - ADDING a value breaks the `sample()` switch in `__tests__`, which must
 *     return a `TagTarget` for every `TargetKind` — so a new kind cannot land
 *     without the payload variant that goes with it.
 *
 * Note what derivation does NOT do: an added value is not automatically legal
 * to store. `content_tags_target_chk` enumerates all five kinds exhaustively,
 * so a sixth needs a REPLACEMENT constraint, not an amendment — which is the
 * reason all five landed at once.
 *
 * The import is `import type`, which is what keeps this module pure: a
 * type-only import is erased entirely by the compiler, so nothing about
 * `@pagespace/db` — least of all its `db` singleton — is present at runtime.
 * The purity test enforces exactly that distinction, following the same rule
 * `services/__tests__/page-webhook-core.test.ts` already applies to its own
 * schema imports.
 */
export type TargetKind = ContentTagTargetKind;

/**
 * A tag's attachment point, payload included.
 *
 * This union IS the XOR that the Phase 2 CHECK constraint enforces — an anchor
 * for the anchored kinds, exactly one message id for the row-identified kinds,
 * nothing for a whole page — written once, in TypeScript. Callers in this repo
 * get it at compile time; the constraint catches everyone else.
 */
export type TagTarget =
  | { kind: 'page' }
  | { kind: 'text'; anchor: TextAnchor }
  | { kind: 'sheet_cell'; anchor: SheetCellAnchor }
  | { kind: 'channel_message'; channelMessageId: string }
  | { kind: 'ai_message'; aiMessageId: string };

/**
 * Which target kinds each page type accepts.
 *
 * Not hand-picked: every page type gets `'page'`, plus at most one
 * content-level kind chosen by how that content is addressable —
 *
 *   anchored prose offsets  -> 'text'             DOCUMENT, CANVAS, CODE
 *   natural key (sheet, A1) -> 'sheet_cell'       SHEET
 *   stable cuid2 row id     -> the message kinds  CHANNEL, AI_CHAT
 *   no addressable unit     -> nothing            FOLDER, FILE, TASK_LIST
 *
 * The first two land exactly on the page types with `supportsVersioning: true`
 * in PAGE_TYPE_CONFIGS, which is not a coincidence and is asserted as a
 * cross-registry drift test: forward-porting is the primary anchoring mechanism
 * and it needs the version chain, so a page type that cannot version cannot
 * carry an anchored tag. FILE is the clearest case — no versioning, and its
 * default content is the empty string.
 *
 * TASK_LIST is `['page']` because `task_items.pageId` is notNull and unique: a
 * task IS a page, so it inherits `['page', 'text']` through its own DOCUMENT
 * page rather than needing a kind of its own.
 *
 * `as const satisfies Record<...>` rather than a plain Record: the
 * exhaustiveness check makes a new page type without an entry a compile error,
 * and the `as const` keeps the literal value types instead of widening them to
 * TargetKind[]. Keyed by PageTypeValue so the list cannot be hand-written —
 * see #2150, where three re-declarations drifted and silently dropped FILE.
 */
export const TAG_TARGETS = {
  FOLDER: ['page'],
  DOCUMENT: ['page', 'text'],
  CHANNEL: ['page', 'channel_message'],
  AI_CHAT: ['page', 'ai_message'],
  CANVAS: ['page', 'text'],
  FILE: ['page'],
  SHEET: ['page', 'sheet_cell'],
  TASK_LIST: ['page'],
  CODE: ['page', 'text'],
} as const satisfies Record<PageTypeValue, readonly TargetKind[]>;

export type TargetRejection =
  /**
   * Not a page type this build knows about. `pageType` is typed `string` here
   * precisely because the value failed to be a PageTypeValue.
   */
  | { ok: false; reason: 'unknown_page_type'; pageType: string }
  /** This page type does not accept this kind of target at all. */
  | { ok: false; reason: 'kind_not_allowed'; pageType: PageTypeValue; kind: TargetKind }
  /** The payload does not match the kind it claims. */
  | { ok: false; reason: 'payload_mismatch'; kind: TargetKind; detail: string };

/**
 * The keys of TAG_TARGETS as a Set, derived so it cannot drift from the
 * registry it guards.
 *
 * A Set rather than an `in` check or a bare index, because an object lookup
 * reaches the prototype: `TAG_TARGETS['constructor']` is a function, not
 * undefined, so a falsy guard would wave it through and the `.includes` below
 * would throw anyway. Phase 0 shipped exactly this bug in the HTML entity
 * table; this is the same shape in a second place.
 */
const KNOWN_PAGE_TYPES: ReadonlySet<string> = new Set(Object.keys(TAG_TARGETS));

/**
 * Whether `value` is a page type this build can tag, narrowing it if so.
 *
 * Exported because the service layer needs the same narrowing before it can
 * index TAG_TARGETS itself, and a second hand-rolled check would be free to
 * disagree with this one.
 */
export function isTaggablePageType(value: string): value is PageTypeValue {
  return KNOWN_PAGE_TYPES.has(value);
}

export type TargetValidation = { ok: true } | TargetRejection;

/**
 * The guard the service and the database must agree on.
 *
 * Two rules, and they get separate reasons because only one of them is shared:
 * `payload_mismatch` is also enforced by the Phase 2 CHECK constraint, whereas
 * page-type compatibility is a rule the database never sees. That asymmetry is
 * exactly why it needs a test here.
 */
export function validateTarget(pageType: string, target: TagTarget): TargetValidation {
  // `string`, not PageTypeValue, on purpose. This is the runtime boundary: the
  // value arrives from a request body or a `pages.type` column, and the DB's
  // PageType enum still contains MACHINE — deleted from the TS enum in the
  // Phase 8 teardown because Postgres cannot DROP VALUE. A narrower parameter
  // would force every real caller to write `as PageTypeValue` to reach this
  // function at all, which is the cast this check exists to make unnecessary.
  if (!isTaggablePageType(pageType)) {
    return { ok: false, reason: 'unknown_page_type', pageType };
  }

  const allowed: readonly TargetKind[] = TAG_TARGETS[pageType];
  if (!allowed.includes(target.kind)) {
    return { ok: false, reason: 'kind_not_allowed', pageType, kind: target.kind };
  }

  if (target.kind === 'channel_message' && target.channelMessageId.length === 0) {
    return {
      ok: false,
      reason: 'payload_mismatch',
      kind: target.kind,
      detail: 'channelMessageId is empty',
    };
  }

  if (target.kind === 'ai_message' && target.aiMessageId.length === 0) {
    return {
      ok: false,
      reason: 'payload_mismatch',
      kind: target.kind,
      detail: 'aiMessageId is empty',
    };
  }

  // `target` gets the same treatment as `pageType` above: it arrives from a
  // request body, so a missing payload must be a rejection rather than a
  // TypeError from the guard the service and the database are meant to agree on.
  if ((target.kind === 'text' || target.kind === 'sheet_cell') && !target.anchor) {
    return {
      ok: false,
      reason: 'payload_mismatch',
      kind: target.kind,
      detail: 'anchor is missing',
    };
  }

  if (target.kind === 'text') {
    const { anchor } = target;
    // An anchor with no quote AND no context on either side cannot be located
    // by anything: resolveAnchor orphans exactly this shape, so a tag stored
    // with it is orphaned from birth. A caret WITH context is legitimate.
    if (anchor.exact.length === 0 && anchor.prefix.length === 0 && anchor.suffix.length === 0) {
      return {
        ok: false,
        reason: 'payload_mismatch',
        kind: target.kind,
        detail: 'anchor has neither a quote nor any context',
      };
    }
    if (!(anchor.start >= 0) || !(anchor.end >= anchor.start)) {
      return {
        ok: false,
        reason: 'payload_mismatch',
        kind: target.kind,
        detail: `anchor range is not ascending: ${anchor.start}..${anchor.end}`,
      };
    }
  }

  if (target.kind === 'sheet_cell') {
    // Both halves of the natural key, not just one. A sheet cell is identified
    // by (sheet name, A1 address), so an anchor missing either half points at
    // nothing — and an address that is merely non-empty still points at nothing
    // if it is not in A1 form. isValidCellAddress is the same check the sheet
    // code itself uses, so the guard and the storage agree by construction.
    if (target.anchor.sheet.length === 0) {
      return {
        ok: false,
        reason: 'payload_mismatch',
        kind: target.kind,
        detail: 'sheet name is empty',
      };
    }
    // Canonical form, not merely a form isValidCellAddress tolerates. That
    // helper trims and upper-cases before testing, so 'aa10' and ' A1 ' pass —
    // but the payload is stored verbatim while sheet storage keys cells by the
    // UPPERCASED address (sheets/io.ts), so a tag on 'aa10' would validate and
    // then never match cells['AA10']. Requiring the canonical form is what
    // actually makes the guard and the storage agree; the service upper-cases
    // before calling, since a pure function cannot do it for the caller.
    const { address } = target.anchor;
    if (!isValidCellAddress(address) || address !== address.trim().toUpperCase()) {
      return {
        ok: false,
        reason: 'payload_mismatch',
        kind: target.kind,
        detail: `not a canonical A1 cell address: ${JSON.stringify(address)}`,
      };
    }
  }

  return { ok: true };
}
