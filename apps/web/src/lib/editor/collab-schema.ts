import type { Extensions } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import type { Schema, NodeSpec, MarkSpec } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { TableKit } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Highlight } from '@tiptap/extension-highlight';
import { TextAlign } from '@tiptap/extension-text-align';
import { PageMentionNode } from '@/lib/editor/page-mention-node';
import { CodeBlockNode } from '@/lib/editor/code-block';
import { BlockId } from '@/lib/editor/block-id';
import { CommentMark, InsertionMark, DeletionMark } from '@/lib/editor/collab-marks';
import { ImageNode } from '@/lib/editor/image-node';

/**
 * `packages/editor` will own this module eventually (Phase B leaf: "Scaffold
 * packages/editor"). It lives in `apps/web/src/lib/editor` for now because
 * that scaffold — 21 files, 9 Docker COPY sites — is deliberately its own
 * change. Every import here is Node-safe (no React, no `document`/`window`
 * at module-eval time), which is what lets `packages/editor` re-export this
 * file's contents unchanged later, and lets a future headless collab server
 * import `collabExtensions()`/`SCHEMA_HASH`/`COLLAB_SCHEMA_VERSION` directly
 * without pulling in React. `clientExtensions()` — which DOES need React —
 * lives in the sibling `client-schema.ts` precisely so importing it doesn't
 * drag React into this module's import graph.
 */

/**
 * Pure function returning the extension list that defines the ProseMirror
 * schema every stored DOCUMENT is parsed and serialized against —
 * `COLLAB_SCHEMA_VERSION` v1. Node-safe: constructing this list, and calling
 * `getSchema()` over it, touches no `document`/`window`. This is the single
 * input `SCHEMA_HASH` is computed from; nothing schema-affecting may live
 * outside this list.
 *
 * Excludes everything view-only: `Placeholder`, `CharacterCount`,
 * `FindExtension`, `PaginationPlus` (plugins/decorations/storage, verified to
 * produce an identical projected hash with or without them), `CodeBlockShiki`
 * (its Shiki highlighting/React node view — `CodeBlockNode` here is the
 * schema-only base it extends), `PageMention`'s node view and suggestion
 * picker (`PageMentionNode` here is the schema-only base), and
 * `Collaboration`/`CollaborationCaret` (Yjs sync plumbing, not schema). See
 * `client-schema.ts` for all of those.
 *
 * v1 additions beyond the pre-freeze `RichEditor` list, per the
 * `COLLAB_SCHEMA_VERSION` v1 decision (evidence: round-two content census,
 * 2026-08-25, `c2968e99e`):
 *  - `taskList`/`taskItem` — 359 pages (largest single gap the census found).
 *  - `image` — file-reference-only node; see `image-node.ts` for why never a
 *    URL. 9 instances measured, but that count is a tautology (no image node
 *    ever existed to contain more); images are wanted and unbuilt.
 *  - heading levels 4–6 (was 1–3) — Class C for the CRDT; 26 pages measured.
 *  - `highlight` mark — 4 pages measured.
 *  - `textAlign` global attribute on `paragraph`/`heading` — verified dropped
 *    from the pre-freeze list; no census count (adding an attribute to an
 *    existing node after documents exist is the Class-A-adjacent default
 *    case, so this front-runs it rather than waiting for evidence).
 *  - `blockId`, `changeId`, `changeType` on every block node (`block-id.ts`)
 *    and the inert `comment`/`insertion`/`deletion` marks (`collab-marks.ts`)
 *    — schema-only, no UI, no commands.
 *  - `FontFormatting` deleted (not moved): `TextStyleKit` already registers
 *    the same `fontFamily`/`fontSize` global attributes on `textStyle` via
 *    its bundled `FontFamily`/`FontSize` extensions (verified against
 *    `@tiptap/extension-text-style@3.23.5` source) — `FontFormatting` was a
 *    duplicate registration, which is exactly the kind of thing that makes
 *    `SCHEMA_HASH` unstable (see its docstring below).
 *  - `tight` on `bulletList`/`orderedList` — already present: `Markdown`
 *    (`tiptap-markdown@0.8.10`) registers `MarkdownTightLists` via its own
 *    `addExtensions()`, defaulting `tight: true`. Nothing to add; recorded
 *    here so the confirmation isn't lost.
 *
 * Deliberately NOT decided here: raw-HTML passthrough (24 pages measured by
 * the census; "needs its own decision; do not silently drop" per the v1
 * leaf). No node is added for it in this PR — it is an open decision, not a
 * silent drop. Superscript/subscript are also not included: the v1
 * RECOMMENDATION table confirms only `highlight` from that family, and the
 * census constructs module (`census/constructs.ts`) has no superscript/
 * subscript detector, so there is no positive evidence for either.
 */
export function collabExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: {
        levels: [1, 2, 3, 4, 5, 6],
      },
      link: {
        openOnClick: true,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
      },
      codeBlock: false,
      undoRedo: false,
    }),
    CodeBlockNode,
    Markdown,
    TextStyleKit,
    TableKit,
    TaskList,
    TaskItem,
    ImageNode,
    Highlight,
    TextAlign.configure({ types: ['paragraph', 'heading'] }),
    PageMentionNode,
    BlockId,
    CommentMark,
    InsertionMark,
    DeletionMark,
  ];
}

// ---------------------------------------------------------------------------
// Schema-drift guard
// ---------------------------------------------------------------------------

interface ProjectedSpec {
  name: string;
  group?: string;
  content?: string;
  marks?: string;
  inline: boolean;
  atom: boolean;
  attrs: string[];
}

/**
 * `Schema.spec` is `{ nodes: OrderedMap<NodeSpec>, marks: OrderedMap<MarkSpec>,
 * topNode? }` — order-preserving but NOT directly JSON-serialisable.
 * `NodeSpec.toDOM`/`parseDOM.getAttrs` are functions, and `attrs[x].default`
 * can hold arbitrary values, so `JSON.stringify(schema.spec)` silently drops
 * every function. This projects deliberately: name, group, content
 * expression, inline/atom flags, and the SORTED set of attribute names —
 * structure and names only, never the attribute default values themselves
 * (some defaults, like `blockId`, are intentionally per-instance `null` and
 * carry no drift signal) and never `parseDOM`/`toDOM`/`parseHTML`/`renderHTML`.
 *
 * That is a real, measured blind spot, not a hedge: removing `FontFormatting`
 * from the pre-v1 extension list produced an identical projected hash to
 * keeping it, because it and `TextStyleKit` declared the same attribute names
 * with the same defaults and differed only in `parseHTML`. A change that
 * silently repoints which parser is live for an existing attribute sails
 * straight through this guard. It catches node/mark/attribute
 * additions, removals, and renames — not behavior changes within an
 * unchanged shape.
 *
 * Order-insensitive by construction (map keys are sorted before hashing), so
 * reordering `collabExtensions()` does not change `SCHEMA_HASH` even though
 * `OrderedMap`'s own attribute order does shift with registration order.
 */
function projectSpec(map: { toObject(): Record<string, NodeSpec | MarkSpec> }): ProjectedSpec[] {
  return Object.entries(map.toObject())
    .map(([name, spec]) => {
      const nodeSpec = spec as Partial<NodeSpec>;
      return {
        name,
        group: nodeSpec.group,
        content: nodeSpec.content,
        marks: nodeSpec.marks,
        inline: Boolean(nodeSpec.inline),
        atom: Boolean(nodeSpec.atom),
        attrs: Object.keys(spec.attrs ?? {}).sort(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The projection `SCHEMA_HASH` is computed from — exported so tests can recompute it independently of the constant. */
export function projectSchema(schema: Schema): { nodes: ProjectedSpec[]; marks: ProjectedSpec[] } {
  return {
    nodes: projectSpec(schema.spec.nodes),
    marks: projectSpec(schema.spec.marks),
  };
}

/**
 * Deliberately non-cryptographic (djb2 over the projection's JSON). This is a
 * drift DETECTOR, not a security boundary — no adversarial input, and it must
 * run identically in the browser (no `node:crypto`) and in Node (the collab
 * server, future seed scripts).
 */
export function hashProjection(projection: unknown): string {
  const json = JSON.stringify(projection);
  let hash = 5381;
  for (let i = 0; i < json.length; i += 1) {
    hash = (hash * 33 + json.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

/**
 * The frozen v1 schema's hash. Changes on ANY schema change — Class A, B or
 * C alike (though C changes to `parseHTML`/`renderHTML`/`toDOM` are the
 * documented blind spot above and will NOT move this hash). Recomputed by
 * `collab-schema-drift-guard.test.ts` on every CI run; a mismatch there means
 * `collabExtensions()` changed without this constant being updated —
 * deliberately, since regenerating it is a one-line diff and forces the
 * author to look at `COLLAB_SCHEMA_VERSION` next to it.
 *
 * IMPORTANT: `RichEditor` (`RichEditor.tsx`) is not only the collaborative
 * document editor. It is also the task-description editor —
 * `TaskDetailSheet.tsx:329`, `TaskListDescription.tsx:85`,
 * `TaskDocumentRow.tsx:50` — and those surfaces are never Y.Doc-backed. They
 * still share this frozen schema, because `RichEditor` calls
 * `clientExtensions()` (`client-schema.ts`) unconditionally. So adding a node
 * "just for task descriptions" changes `SCHEMA_HASH` and, if it is a Class
 * A/B change, must bump `COLLAB_SCHEMA_VERSION` too — even though no
 * collaborative document is involved. The drift guard will catch the hash
 * change; it cannot catch a version bump a human declined to make.
 */
export const SCHEMA_HASH = hashProjection(projectSchema(getSchema(collabExtensions())));

/**
 * Bumped only for Class A (remove/rename/narrow an existing node, mark or
 * attribute, or change an attribute's default) or Class B (add a node or
 * mark — old documents are unaffected, but a v(N-1) client cannot represent
 * a vN node arriving over the wire) changes. NEVER bumped for Class C
 * (`parseDOM`/`toDOM` only) changes — that would force every open client to
 * reload for a change that doesn't touch the stored CRDT.
 *
 * This is the integer the collab server gates connections on: a client
 * reporting a version below this one is refused or force-reloaded rather
 * than allowed to write a schema shape it cannot fully represent. It is a
 * SEPARATE constant from `SCHEMA_HASH` on purpose — seeing `SCHEMA_HASH`
 * change in a diff is not itself evidence this needs to move; classify the
 * change first (v1 decision leaf, `oopiowlhezncu0m63tvees7i`), then bump
 * only if it is Class A or B.
 */
export const COLLAB_SCHEMA_VERSION = 1;
