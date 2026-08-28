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
import { readFileSync } from 'node:fs';
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

  it('RichEditor.tsx does not inline an extensions: [ array', () => {
    const source = readFileSync(RICH_EDITOR_PATH, 'utf8');
    expect(source).not.toMatch(/extensions:\s*\[/);
  });
});
