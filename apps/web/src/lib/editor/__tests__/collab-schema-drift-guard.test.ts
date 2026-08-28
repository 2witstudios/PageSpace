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
import { getSchema, Node } from '@tiptap/core';
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
const INLINE_EXTENSIONS_ARRAY = /extensions:\s*\[/;

/**
 * Pure scan of one file's source for a hand-rolled `extensions: [...]`
 * array, given its already-read contents. Extracted from the directory walk
 * below so both the "offense found" and "clean source" branches are
 * exercised directly, matching the pattern used by
 * `apps/realtime/src/__tests__/room-grammar-drift-guard.test.ts`.
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

describe('SCHEMA_HASH projection is order-insensitive', () => {
  it('hashes identically regardless of extension registration order', () => {
    const forward = projectSchema(getSchema(collabExtensions()));
    const reversed = projectSchema(getSchema([...collabExtensions()].reverse()));
    expect(hashProjection(reversed)).toBe(hashProjection(forward));
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
});

describe('structural guard: no source file bypasses clientExtensions()/collabExtensions() with a hand-rolled extensions array', () => {
  it('no file under apps/web/src inlines an extensions: [ array', () => {
    const offenders: string[] = [];
    for (const entry of readdirSync(APP_SRC_DIR, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const path = join(entry.parentPath, entry.name);
      // client-schema.ts/collab-schema.ts themselves return extension arrays
      // (`return [...]`), never assign one to an `extensions:` property key —
      // no exclusion needed, and leaving them scanned proves that.
      if (path.includes(`${join('__tests__', '')}`)) continue;

      offenders.push(...findInlineExtensionsArrayOffenses(path, readFileSync(path, 'utf8')));
    }

    expect(
      offenders,
      `TipTap extension lists must come from collabExtensions()/clientExtensions() (apps/web/src/lib/editor):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
