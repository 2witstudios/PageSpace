/**
 * Schema-drift guard (Phase B — COLLAB_SCHEMA_VERSION v1 freeze).
 *
 * Modelled on `apps/realtime/src/__tests__/room-grammar-drift-guard.test.ts`:
 * a semantic guard (the frozen schema's hash matches what the extension list
 * actually produces, and the client can represent everything the schema
 * can) plus a structural guard (no source file bypasses the shared
 * extension-list functions).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSchema, Node, Mark } from '@tiptap/core';
import { Schema as PMSchema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import {
  collabExtensions,
  projectSchema,
  hashProjection,
  SCHEMA_HASH,
  COLLAB_SCHEMA_VERSION,
} from '../collab-schema';
import { clientExtensions } from '../client-schema';

const EDITOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const RICH_EDITOR_PATH = join(
  EDITOR_DIR,
  '..',
  '..',
  'components',
  'editors',
  'RichEditor.tsx',
);
const APP_SRC_DIR = join(EDITOR_DIR, '..', '..');

// Any `extensions:` property assigned a literal array is a hand-rolled
// TipTap extension list — the only sanctioned way to build one is
// collabExtensions()/clientExtensions() (this directory), consumed as
// `extensions: clientExtensions(...)` (a function CALL, which this pattern
// does not match). Comments are stripped first so documentation may still
// describe the shape without tripping the guard.
//
// Textual, not semantic: `const exts = [StarterKit]; useEditor({ extensions: exts })`
// bypasses this guard via one level of indirection. Same limitation as the
// literal-scan `apps/realtime/src/__tests__/room-grammar-drift-guard.test.ts`
// this is modelled on — accepted there for the same reason: catching the
// common case (a hand-rolled array typed straight into the call) at near-zero
// cost beats building a real static analyzer for a determined bypass.
const INLINE_EXTENSIONS_ARRAY = /extensions:\s*\[/;

/**
 * Pure scan of one file's source for a hand-rolled `extensions: [...]`
 * array, given its already-read contents. Extracted from the directory walk
 * below so both the "offense found" and "clean source" branches are
 * exercised directly, matching the pattern used by
 * `apps/realtime/src/__tests__/room-grammar-drift-guard.test.ts`.
 *
 * The comment-stripping regex is NAIVE — it does not tokenize the source, so
 * a `/*`-or-`*``/`-shaped sequence inside a STRING or REGEX literal (not an
 * actual comment) confuses it into treating unrelated code as commented-out.
 * Verified concretely against `monaco/sudolang-language.ts`, whose Monarch
 * tokenizer rules contain regex literals matching `/\*` and `*\/`: this
 * function silently deletes that file's real, uncommented
 * `extensions: ['.sudo', '.sudolang']` (Monaco's own, unrelated
 * `LanguageConfiguration.extensions` — file extensions, not a TipTap list)
 * along with everything the naive stripper mistakes for the "comment" body.
 * That is a false NEGATIVE risk (a real TipTap bypass could be hidden the
 * same way) as much as it is a false positive on Monaco's own property, so
 * `monaco/` is excluded from the directory walk below rather than trusted to
 * round-trip through this stripper correctly.
 */
function findInlineExtensionsArrayOffenses(path: string, rawSource: string): string[] {
  const source = rawSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  const offenses: string[] = [];
  for (const [index, line] of source.split('\n').entries()) {
    if (INLINE_EXTENSIONS_ARRAY.test(line)) {
      offenses.push(`${path}:${index + 1}: ${line.trim()}`);
    }
  }
  return offenses;
}

describe('COLLAB_SCHEMA_VERSION v1 constants', () => {
  it('COLLAB_SCHEMA_VERSION starts at 1', () => {
    expect(COLLAB_SCHEMA_VERSION).toBe(1);
  });

  it('SCHEMA_HASH matches a hash recomputed from collabExtensions() right now', () => {
    const recomputed = hashProjection(projectSchema(getSchema(collabExtensions())));
    expect(SCHEMA_HASH).toBe(recomputed);
  });
});

describe('client/server schema parity', () => {
  it('clientExtensions({ readOnly: false }) represents exactly the frozen schema', () => {
    const serverProjection = projectSchema(getSchema(collabExtensions()));
    const clientProjection = projectSchema(
      getSchema(clientExtensions({ readOnly: false, isPaginated: false })),
    );
    expect(clientProjection).toEqual(serverProjection);
  });

  it('clientExtensions({ readOnly: true }) represents exactly the frozen schema', () => {
    const serverProjection = projectSchema(getSchema(collabExtensions()));
    const clientProjection = projectSchema(
      getSchema(clientExtensions({ readOnly: true, isPaginated: false })),
    );
    expect(clientProjection).toEqual(serverProjection);
  });

  it('clientExtensions({ isPaginated: true }) still represents exactly the frozen schema', () => {
    // PaginationPlus is decoration-based (Class C, no nodes) — this proves it,
    // rather than asserting it from the leaf's claim alone.
    const serverProjection = projectSchema(getSchema(collabExtensions()));
    const clientProjection = projectSchema(
      getSchema(clientExtensions({ readOnly: false, isPaginated: true })),
    );
    expect(clientProjection).toEqual(serverProjection);
  });
});

describe('mutation check: the parity assertion actually catches drift', () => {
  it('fails when the client schema is missing a node the server schema has', () => {
    const serverProjection = projectSchema(getSchema(collabExtensions()));

    // A deliberately DIFFERENT extension list — StarterKit alone, missing
    // everything collabExtensions() adds (tables, task lists, image, marks,
    // blockId, ...). This never touches the real client-schema.ts; it proves
    // the equality assertion above is not vacuously true.
    const driftedProjection = projectSchema(getSchema([StarterKit]));

    expect(driftedProjection).not.toEqual(serverProjection);
  });

  it('fails when a copy of the extension list drops one schema-affecting member', () => {
    const full = collabExtensions();
    expect(full.length).toBeGreaterThan(1);

    // Drop the last extension (DeletionMark) rather than StarterKit — doc/
    // paragraph/text are load-bearing for getSchema() itself and removing
    // them throws before a projection can even be compared, which proves
    // nothing about the equality assertion this guard actually runs.
    const withOneRemoved = full.slice(0, -1);
    const fullProjection = projectSchema(getSchema(full));
    const droppedProjection = projectSchema(getSchema(withOneRemoved));

    expect(droppedProjection).not.toEqual(fullProjection);
    // and the specific thing that disappeared is a real mark, not a
    // coincidental reordering:
    expect(fullProjection.marks.some((m) => m.name === 'deletion')).toBe(true);
    expect(droppedProjection.marks.some((m) => m.name === 'deletion')).toBe(false);
  });
});

describe('SCHEMA_HASH projection order-sensitivity', () => {
  // Corrected finding: nodes and marks behave differently. Node position in
  // a document is explicit, so node registration order is free to change.
  // Mark registration order sets `MarkType.rank` (prosemirror-model), which
  // drives mark-set canonicalization — reordering marks genuinely changes
  // how overlapping marks serialize for the same set, so it MUST move the
  // hash. A single "reverse the whole list" test can't tell these apart
  // (reversing flips both at once); each gets its own case.

  it('reordering nodes relative to each other does not change the hash', () => {
    const NodeA = Node.create({ name: 'nodeA', group: 'block', content: 'text*' });
    const NodeB = Node.create({ name: 'nodeB', group: 'block', content: 'text*' });
    const forward = projectSchema(getSchema([StarterKit, NodeA, NodeB]));
    const reversed = projectSchema(getSchema([StarterKit, NodeB, NodeA]));
    expect(hashProjection(reversed)).toBe(hashProjection(forward));
  });

  it('reordering marks relative to each other changes the hash', () => {
    const MarkA = Mark.create({ name: 'markA' });
    const MarkB = Mark.create({ name: 'markB' });
    const forward = projectSchema(getSchema([StarterKit, MarkA, MarkB]));
    const reversed = projectSchema(getSchema([StarterKit, MarkB, MarkA]));
    expect(hashProjection(reversed)).not.toBe(hashProjection(forward));
  });

  it('collabExtensions() itself is deterministic', () => {
    // Now that arbitrary reordering is NOT assumed harmless, this confirms
    // the real, frozen list's own output is stable across calls.
    const first = projectSchema(getSchema(collabExtensions()));
    const second = projectSchema(getSchema(collabExtensions()));
    expect(hashProjection(second)).toBe(hashProjection(first));
  });
});

describe('projectSpec captures attribute default changes (Class A)', () => {
  // A single node, differing ONLY in one attribute's default — same node
  // name, same attribute name, same structure. Before this fix, projectSpec
  // hashed only attribute NAMES, so this pair produced an identical
  // projection and SCHEMA_HASH would not move for e.g. changing
  // `pageMention.mentionType`'s default from 'page' to something else, even
  // though the v1 decision classifies an attribute-default change as Class A.
  function schemaWithDefault(defaultValue: string) {
    const TestNode = Node.create({
      name: 'testNode',
      group: 'block',
      addAttributes() {
        return { kind: { default: defaultValue } };
      },
    });
    return getSchema([StarterKit, TestNode]);
  }

  it('produces different projections for two schemas differing only in an attribute default', () => {
    const withDefaultA = projectSchema(schemaWithDefault('a'));
    const withDefaultB = projectSchema(schemaWithDefault('b'));
    expect(withDefaultA).not.toEqual(withDefaultB);
    expect(hashProjection(withDefaultA)).not.toBe(hashProjection(withDefaultB));
  });

  it('produces identical projections for two schemas with the same default', () => {
    const first = projectSchema(schemaWithDefault('a'));
    const second = projectSchema(schemaWithDefault('a'));
    expect(first).toEqual(second);
  });
});

describe('projectSpec distinguishes a required attribute from an explicit null default', () => {
  // ProseMirror treats these as materially different: an attribute with no
  // `default` key is REQUIRED (throws if omitted when creating the node);
  // one with `default: null` is optional and resolves to null. Collapsing
  // both to the string "null" (the pre-fix behavior) hid a Class A change —
  // making a required attribute optional, or vice versa — from SCHEMA_HASH.
  function schemaWithAttr(attr: { isRequired?: boolean; default?: unknown }) {
    const TestNode = Node.create({
      name: 'testNode',
      group: 'block',
      addAttributes() {
        return { kind: attr };
      },
    });
    return getSchema([StarterKit, TestNode]);
  }

  it('projects a required attribute (no default key) differently from default: null', () => {
    // TipTap only omits `default` from the compiled NodeSpec when the
    // extension explicitly marks the attribute `isRequired: true` with no
    // default — `{}` alone still gets `default: null` merged in by TipTap's
    // own attribute normalization (`getAttributesFromExtensions`).
    const required = projectSchema(schemaWithAttr({ isRequired: true }));
    const explicitNull = projectSchema(schemaWithAttr({ default: null }));
    expect(required).not.toEqual(explicitNull);
    expect(hashProjection(required)).not.toBe(hashProjection(explicitNull));
  });
});

describe('projectSpec includes MarkSpec.excludes', () => {
  // excludes controls which marks may coexist on the same text run — a
  // client disagreeing on this can apply the same edit differently. Not part
  // of the projection before this fix, so it was invisible to SCHEMA_HASH.
  function schemaWithExcludes(excludes: string | undefined) {
    const TestMark = Mark.create({
      name: 'testMark',
      excludes,
    });
    return getSchema([StarterKit, TestMark]);
  }

  it('produces different projections for marks with different excludes', () => {
    const excludesSelf = projectSchema(schemaWithExcludes('testMark'));
    const excludesNone = projectSchema(schemaWithExcludes(''));
    expect(excludesSelf).not.toEqual(excludesNone);
    expect(hashProjection(excludesSelf)).not.toBe(hashProjection(excludesNone));
  });
});

describe('projectSpec includes MarkSpec.inclusive', () => {
  // inclusive controls whether text typed at a mark's boundary inherits it —
  // a client disagreeing generates different marked content for the same
  // boundary edit. Not part of the projection before this fix.
  function schemaWithInclusive(inclusive: boolean) {
    const TestMark = Mark.create({
      name: 'testMark',
      inclusive,
    });
    return getSchema([StarterKit, TestMark]);
  }

  it('produces different projections for marks with different inclusive', () => {
    const inclusiveTrue = projectSchema(schemaWithInclusive(true));
    const inclusiveFalse = projectSchema(schemaWithInclusive(false));
    expect(inclusiveTrue).not.toEqual(inclusiveFalse);
    expect(hashProjection(inclusiveTrue)).not.toBe(hashProjection(inclusiveFalse));
  });
});

describe('projectSpec includes NodeSpec.isolating', () => {
  // isolating controls whether editing commands treat this node's boundary
  // as a hard wall — clients disagreeing produce different structural edits
  // from the same command. Not part of the projection before this fix.
  function schemaWithIsolating(isolating: boolean) {
    const TestNode = Node.create({
      name: 'testNode',
      group: 'block',
      content: 'text*',
      isolating,
    });
    return getSchema([StarterKit, TestNode]);
  }

  it('produces different projections for nodes with different isolating', () => {
    const isolatingTrue = projectSchema(schemaWithIsolating(true));
    const isolatingFalse = projectSchema(schemaWithIsolating(false));
    expect(isolatingTrue).not.toEqual(isolatingFalse);
    expect(hashProjection(isolatingTrue)).not.toBe(hashProjection(isolatingFalse));
  });
});

describe('projectSpec includes NodeSpec.defining/definingAsContext/definingForContent', () => {
  // These control whether a node's parents are preserved (vs. discarded)
  // during replace/paste transforms — clients disagreeing produce different
  // document structure from the same paste. Not part of the projection
  // before this fix.
  const baseNodes = {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    text: { group: 'inline' },
  };

  it('produces different projections for nodes with different defining', () => {
    // Via TipTap's Node.create() — `defining` IS one of its recognized
    // config fields (unlike the two below), so this also proves the
    // TipTap-facing path, not just the raw-schema one.
    const TestNode = Node.create({ name: 'testNode', group: 'block', content: 'text*', defining: true });
    const withDefining = projectSchema(getSchema([StarterKit, TestNode]));
    const without = projectSchema(
      getSchema([StarterKit, Node.create({ name: 'testNode', group: 'block', content: 'text*' })]),
    );
    expect(withDefining).not.toEqual(without);
    expect(hashProjection(withDefining)).not.toBe(hashProjection(without));
  });

  it('produces different projections for nodes with different definingAsContext', () => {
    // TipTap's Node.create() silently drops definingAsContext/
    // definingForContent (not in its whitelisted NodeConfig fields) — built
    // as a raw ProseMirror schema instead, like the topNode test above.
    const without = projectSchema(new PMSchema({ nodes: baseNodes }));
    const withFlag = projectSchema(
      new PMSchema({ nodes: { ...baseNodes, paragraph: { ...baseNodes.paragraph, definingAsContext: true } } }),
    );
    expect(withFlag).not.toEqual(without);
    expect(hashProjection(withFlag)).not.toBe(hashProjection(without));
  });

  it('produces different projections for nodes with different definingForContent', () => {
    const without = projectSchema(new PMSchema({ nodes: baseNodes }));
    const withFlag = projectSchema(
      new PMSchema({ nodes: { ...baseNodes, paragraph: { ...baseNodes.paragraph, definingForContent: true } } }),
    );
    expect(withFlag).not.toEqual(without);
    expect(hashProjection(withFlag)).not.toBe(hashProjection(without));
  });
});

describe('projectSpec includes NodeSpec.code/whitespace', () => {
  // ProseMirror uses these to determine whitespace and line-break handling —
  // codeBlock relies on `code: true`. Mixed clients could parse/transform
  // code-block content differently while the hash stayed unchanged.
  function schemaWithCodeNode(flags: { code?: boolean; whitespace?: 'pre' | 'normal' }) {
    const TestNode = Node.create({ name: 'testNode', group: 'block', content: 'text*', ...flags });
    return getSchema([StarterKit, TestNode]);
  }

  it('produces different projections for nodes with different code', () => {
    const withCode = projectSchema(schemaWithCodeNode({ code: true }));
    const without = projectSchema(schemaWithCodeNode({}));
    expect(withCode).not.toEqual(without);
    expect(hashProjection(withCode)).not.toBe(hashProjection(without));
  });

  it('produces different projections for nodes with different whitespace', () => {
    const pre = projectSchema(schemaWithCodeNode({ whitespace: 'pre' }));
    const normal = projectSchema(schemaWithCodeNode({ whitespace: 'normal' }));
    expect(pre).not.toEqual(normal);
    expect(hashProjection(pre)).not.toBe(hashProjection(normal));
  });
});

describe('projectSpec includes NodeSpec.linebreakReplacement and MarkSpec.spanning', () => {
  // linebreakReplacement: setBlockType uses it to convert between newlines
  // and linebreak nodes for whitespace: 'pre' blocks. spanning: whether a
  // mark can span multiple adjacent nodes when serialized. Both
  // compatibility-significant; built as raw ProseMirror schemas (StarterKit
  // already has a linebreakReplacement node — hardBreak — and ProseMirror
  // rejects a second one, so this can't go through Node.create() the way
  // `defining` did).
  const baseNodes = {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline', inline: true },
    br: { group: 'inline', inline: true },
  };

  it('produces different projections for nodes with different linebreakReplacement', () => {
    const without = projectSchema(new PMSchema({ nodes: baseNodes }));
    const withFlag = projectSchema(
      new PMSchema({ nodes: { ...baseNodes, br: { ...baseNodes.br, linebreakReplacement: true } } }),
    );
    expect(withFlag).not.toEqual(without);
    expect(hashProjection(withFlag)).not.toBe(hashProjection(without));
  });

  it('produces different projections for marks with different spanning', () => {
    const without = projectSchema(new PMSchema({ nodes: baseNodes, marks: { testMark: {} } }));
    const withFlag = projectSchema(
      new PMSchema({ nodes: baseNodes, marks: { testMark: { spanning: false } } }),
    );
    expect(withFlag).not.toEqual(without);
    expect(hashProjection(withFlag)).not.toBe(hashProjection(without));
  });
});

describe('projectSchema includes Schema.spec.topNode', () => {
  // Two schemas can have identical node maps yet disagree on which node is
  // the document root — the node/mark maps alone can't catch that. TipTap's
  // getSchema() doesn't expose topNode configuration, so this builds the raw
  // ProseMirror Schema directly — projectSchema only cares about the
  // resulting Schema object, not how it was constructed.
  const nodes = {
    doc: { content: 'block+' },
    altRoot: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    text: { group: 'inline' },
  };

  it('produces different projections for schemas with different topNode', () => {
    const defaultRoot = projectSchema(new PMSchema({ nodes }));
    const customRoot = projectSchema(new PMSchema({ nodes, topNode: 'altRoot' }));
    expect(defaultRoot).not.toEqual(customRoot);
    expect(hashProjection(defaultRoot)).not.toBe(hashProjection(customRoot));
  });
});

describe('structural guard: RichEditor must consume clientExtensions()', () => {
  it('RichEditor.tsx calls clientExtensions(', () => {
    const source = readFileSync(RICH_EDITOR_PATH, 'utf8');
    expect(source).toMatch(/clientExtensions\(/);
  });
});

describe('findInlineExtensionsArrayOffenses (pure scanner)', () => {
  it('flags a hand-rolled inline extensions array', () => {
    const offenses = findInlineExtensionsArrayOffenses(
      'fixture.tsx',
      "useEditor({ extensions: [StarterKit, Bold] });",
    );
    expect(offenses).toEqual(["fixture.tsx:1: useEditor({ extensions: [StarterKit, Bold] });"]);
  });

  it('ignores an extensions array shape named only in a comment', () => {
    const offenses = findInlineExtensionsArrayOffenses(
      'fixture.tsx',
      "// e.g. extensions: [StarterKit]\nuseEditor({ extensions: clientExtensions(opts) });",
    );
    expect(offenses).toEqual([]);
  });

  it('is clean for a call site built from the shared functions', () => {
    const offenses = findInlineExtensionsArrayOffenses(
      'fixture.tsx',
      "useEditor({ extensions: clientExtensions({ readOnly, isPaginated }) });",
    );
    expect(offenses).toEqual([]);
  });

  it('is fooled by regex literals shaped like block comments (documented blind spot)', () => {
    // Locks in the exact failure mode found against monaco/sudolang-language.ts:
    // a `/\*` regex literal opens a "comment" the naive stripper doesn't close
    // until an unrelated later '/*' string literal, deleting the real
    // `extensions: [...]` in between. This is why monaco/ is excluded from the
    // directory walk below rather than trusted to this scanner.
    const source = [
      "const rule = [/\\/\\*/, 'comment'];",
      "export const extensions = ['.sudo', '.sudolang'];",
      "const closer = ['/*', '*/'];",
    ].join('\n');
    const offenses = findInlineExtensionsArrayOffenses('fixture.ts', source);
    expect(offenses).toEqual([]); // BLIND SPOT: a real match exists on line 2 and is missed.
  });
});

/**
 * Paths the directory walk below does not scan.
 * - `__tests__`: client-schema.ts/collab-schema.ts themselves return
 *   extension arrays (`return [...]`), never assign one to an `extensions:`
 *   property key — no exclusion needed there, and leaving those files
 *   scanned proves that; this only excludes test fixtures.
 * - `editor/monaco`: Monaco (code-block language tooling, not TipTap) has
 *   its own unrelated `extensions:` property AND regex literals that defeat
 *   the naive comment stripper in `findInlineExtensionsArrayOffenses` —
 *   see that function's docstring for the concrete, verified failure mode.
 */
function isExcludedFromScan(path: string): boolean {
  return path.includes(`${join('__tests__', '')}`) || path.includes(`${join('editor', 'monaco', '')}`);
}

describe('isExcludedFromScan (pure predicate)', () => {
  it('excludes __tests__ fixtures', () => {
    expect(isExcludedFromScan(join('apps', 'web', 'src', 'lib', 'editor', '__tests__', 'x.test.ts'))).toBe(true);
  });

  it('excludes editor/monaco', () => {
    expect(isExcludedFromScan(join('apps', 'web', 'src', 'lib', 'editor', 'monaco', 'sudolang-language.ts'))).toBe(true);
  });

  it('does not exclude an ordinary editor source file', () => {
    expect(isExcludedFromScan(join('apps', 'web', 'src', 'lib', 'editor', 'block-id.ts'))).toBe(false);
  });

  it('does not exclude a same-named "monaco" file outside editor/', () => {
    // Guards against an overly broad substring match — only editor/monaco/*.
    expect(isExcludedFromScan(join('apps', 'web', 'src', 'components', 'monaco', 'x.ts'))).toBe(false);
  });
});

describe('structural guard: no source file bypasses clientExtensions()/collabExtensions() with a hand-rolled extensions array', () => {
  it('no file under apps/web/src inlines an extensions: [ array', () => {
    const offenders: string[] = [];
    for (const entry of readdirSync(APP_SRC_DIR, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const path = join(entry.parentPath, entry.name);
      if (isExcludedFromScan(path)) continue;

      offenders.push(...findInlineExtensionsArrayOffenses(path, readFileSync(path, 'utf8')));
    }

    expect(
      offenders,
      `TipTap extension lists must come from collabExtensions()/clientExtensions() (apps/web/src/lib/editor):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
