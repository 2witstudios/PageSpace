import type { Extensions } from '@tiptap/core';
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

/**
 * `TextAlign`'s schema-affecting option (the node types it attaches its
 * global `textAlign` attribute to) — shared between `collabExtensions()`
 * (below) and `clientExtensions()` (`client-schema.ts`) for the same reason
 * as `STARTER_KIT_SCHEMA_OPTIONS` below: this exact line was previously
 * duplicated verbatim in both files.
 */
export const TEXT_ALIGN_SCHEMA_OPTIONS = { types: ['paragraph', 'heading'] };

/**
 * StarterKit's schema-affecting options, shared between `collabExtensions()`
 * (below, `undoRedo` always off) and `clientExtensions()`
 * (`client-schema.ts`, `undoRedo` off only when `collab` is mounted).
 * Duplicating this object in both files let it drift silently: a Class-C-only
 * change (e.g. `link.openOnClick`) doesn't move `SCHEMA_HASH`, so nothing
 * would fail if the two files disagreed. One definition makes that
 * impossible instead of relying on both authors remembering to update both
 * places.
 */
export const STARTER_KIT_SCHEMA_OPTIONS = {
  heading: {
    // Mutable, widened to `(1|2|3|4|5|6)[]`: StarterKit's HeadingOptions
    // levels type is `Level[]` from `@tiptap/extension-heading` (not a
    // direct dependency here), which rejects both a readonly tuple and a
    // plain `number[]`. Duplicating the literal union rather than adding a
    // dependency just for this one type.
    levels: [1, 2, 3, 4, 5, 6] as (1 | 2 | 3 | 4 | 5 | 6)[],
  },
  link: {
    openOnClick: true,
    autolink: true,
    linkOnPaste: true,
    defaultProtocol: 'https',
  },
  codeBlock: false as const,
};

export function collabExtensions(): Extensions {
  return [
    StarterKit.configure({
      ...STARTER_KIT_SCHEMA_OPTIONS,
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
    TextAlign.configure(TEXT_ALIGN_SCHEMA_OPTIONS),
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

interface ProjectedAttr {
  name: string;
  /**
   * `JSON.stringify` of `attrs[name].default`, EXCEPT when `default` is
   * absent from the spec entirely — that attribute is REQUIRED (ProseMirror
   * throws when a node is created without it), a materially different
   * compatibility contract than `default: null` (optional, resolves to
   * `null` when omitted). `'<required>'` can never collide with a real
   * `JSON.stringify` output (which always starts with a quote, digit,
   * brace, bracket, or `t`/`f`/`n`), so presence and value both move the
   * hash independently.
   */
  default: string;
}

interface ProjectedSpec {
  name: string;
  group?: string;
  content?: string;
  marks?: string;
  /**
   * Marks only (`MarkSpec.excludes`) — which other marks this one cannot
   * coexist with on the same run. Compatibility-significant: a client
   * disagreeing with the frozen schema on exclusion rules can apply the same
   * edit operation differently. `undefined` for nodes, where it doesn't
   * apply.
   */
  excludes?: string;
  /**
   * Marks only (`MarkSpec.inclusive`) — whether text typed at the boundary
   * of a marked run inherits the mark. Compatibility-significant for the
   * same reason as `excludes`: a client disagreeing on boundary behavior
   * generates different marked content for the same edit. `undefined` for
   * nodes.
   */
  inclusive?: boolean;
  /**
   * Nodes only (`NodeSpec.isolating`) — whether editing commands treat this
   * node's boundary as a hard wall (e.g. arrow-key/backspace behavior at a
   * table cell edge). Compatibility-significant: clients disagreeing on this
   * can produce different structural edits from the same command.
   * `undefined` for marks.
   */
  isolating?: boolean;
  /**
   * Nodes only (`NodeSpec.defining`/`definingAsContext`/`definingForContent`)
   * — whether this node's parents are preserved (vs. discarded) during
   * replace/paste transforms. Compatibility-significant: clients disagreeing
   * on these can produce different document structure from the same paste.
   * `undefined` for marks.
   */
  defining?: boolean;
  definingAsContext?: boolean;
  definingForContent?: boolean;
  /**
   * Nodes only (`NodeSpec.code`/`NodeSpec.whitespace`) — whitespace and
   * line-break handling; `codeBlock` relies on `code: true`. Compatibility-
   * significant: mixed clients could parse or transform code-block content
   * differently. `undefined` for marks.
   */
  code?: boolean;
  whitespace?: 'pre' | 'normal';
  /**
   * Nodes only (`NodeSpec.linebreakReplacement`) — whether this inline node
   * is a linebreak equivalent; `setBlockType` uses it to convert between
   * newlines and linebreak nodes for `whitespace: 'pre'` blocks.
   * Compatibility-significant for the same reason as `whitespace`.
   * `undefined` for marks.
   */
  linebreakReplacement?: boolean;
  /**
   * Marks only (`MarkSpec.spanning`) — whether this mark can span multiple
   * adjacent nodes when serialized to DOM/HTML. Compatibility-significant:
   * clients disagreeing produce different serialized output for the same
   * marked content. `undefined` for nodes.
   */
  spanning?: boolean;
  inline: boolean;
  atom: boolean;
  attrs: ProjectedAttr[];
}

/**
 * `Schema.spec` is `{ nodes: OrderedMap<NodeSpec>, marks: OrderedMap<MarkSpec>,
 * topNode? }` — order-preserving but NOT directly JSON-serialisable.
 * `NodeSpec.toDOM`/`parseDOM.getAttrs` are functions, so `JSON.stringify(schema.spec)`
 * silently drops every function. This projects deliberately: name, group,
 * content expression, inline/atom flags, and the SORTED set of attributes —
 * each attribute's name AND its `JSON.stringify`-d default value — never
 * `parseDOM`/`toDOM`/`parseHTML`/`renderHTML`. An attribute's default is part
 * of the schema's compatibility surface (changing `pageMention.mentionType`'s
 * default from `'page'` would reinterpret every stored node that omits it —
 * Class A) and must move the hash; `blockId`'s own default is `null` either
 * way, but the mechanism has to hash *whatever* the default is, not special-
 * case it away.
 *
 * That is a real, measured blind spot, not a hedge: removing `FontFormatting`
 * from the pre-v1 extension list produced an identical projected hash to
 * keeping it, because it and `TextStyleKit` declared the same attribute names
 * with the same defaults and differed only in `parseHTML`. A change that
 * silently repoints which parser is live for an existing attribute sails
 * straight through this guard. It catches node/mark/attribute additions,
 * removals, renames, and default-value changes — not behavior changes within
 * an otherwise-unchanged shape.
 *
 * Order-insensitive for NODES (sorted alphabetically before hashing), but
 * NOT for marks: `MarkType.rank` (`prosemirror-model`) is assigned by
 * registration order and drives mark-set canonicalization, so reordering
 * marks in `collabExtensions()` genuinely changes how overlapping marks
 * serialize for the same underlying set — this is Class A, and the mark
 * projection preserves registration order specifically so a hash mismatch
 * catches it. Reordering NODES (or reordering marks relative to nodes, e.g.
 * moving `Highlight` earlier in the array without moving it past another
 * mark) is still free — verified by a mutation-checked test, not asserted
 * on the design's own claim alone.
 *

 * Deliberately NOT hashed: `AttrSpec.validate`. Unlike `excludes`/
 * `inclusive` (booleans/strings — stable, cheap to compare), `validate` can
 * be an arbitrary function, and no attribute in this extension set currently
 * sets one. Hashing it via `fn.toString()` would make `SCHEMA_HASH` move on
 * a harmless reformat or rebuild of semantically-identical logic — false
 * instability is worse than the blind spot, for a case nothing here uses.
 * Revisit if an attribute here ever needs a validator.
 */
/**
 * `preserveOrder: true` for marks — see the docstring above: `MarkType.rank`
 * (`prosemirror-model`) is assigned by iteration order of the schema's mark
 * `OrderedMap`, and mark-set canonicalization (`Mark.addToSet`,
 * `Fragment`'s mark sort) uses that rank, so reordering marks in
 * `collabExtensions()` changes how overlapping marks nest in serialized
 * output for the SAME underlying mark set — a real compatibility
 * difference, not cosmetic. `false` for nodes: node position in a document
 * is explicit (not a canonicalized set), so node registration order has no
 * equivalent effect, and alphabetical sorting keeps the hash stable across
 * harmless node-list reordering.
 */
function projectSpec(
  map: { toObject(): Record<string, NodeSpec | MarkSpec> },
  preserveOrder: boolean,
): ProjectedSpec[] {
  const entries = Object.entries(map.toObject())
    .map(([name, spec]) => {
      const nodeSpec = spec as Partial<NodeSpec>;
      const markSpec = spec as Partial<MarkSpec>;
      const attrs = spec.attrs ?? {};
      return {
        name,
        group: nodeSpec.group,
        content: nodeSpec.content,
        marks: nodeSpec.marks,
        excludes: markSpec.excludes,
        inclusive: markSpec.inclusive,
        isolating: nodeSpec.isolating,
        defining: nodeSpec.defining,
        definingAsContext: nodeSpec.definingAsContext,
        definingForContent: nodeSpec.definingForContent,
        code: nodeSpec.code,
        whitespace: nodeSpec.whitespace,
        linebreakReplacement: nodeSpec.linebreakReplacement,
        spanning: markSpec.spanning,
        inline: Boolean(nodeSpec.inline),
        atom: Boolean(nodeSpec.atom),
        attrs: Object.keys(attrs)
          .sort()
          .map((attrName) => ({
            name: attrName,
            default: 'default' in attrs[attrName]
              ? JSON.stringify(attrs[attrName].default)
              : '<required>',
          })),
      };
    });
  return preserveOrder ? entries : entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** The projection `SCHEMA_HASH` is computed from — exported so tests can recompute it independently of the constant. */
export function projectSchema(schema: Schema): { nodes: ProjectedSpec[]; marks: ProjectedSpec[]; topNode?: string } {
  return {
    nodes: projectSpec(schema.spec.nodes, false),
    marks: projectSpec(schema.spec.marks, true),
    // Which node the document root must be. Two schemas with identical node
    // maps can still disagree on this — e.g. StarterKit's default `doc` vs a
    // hypothetical custom root — which the node/mark maps alone can't catch.
    topNode: schema.spec.topNode,
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
 * documented blind spot above and will NOT move this hash).
 *
 * DELIBERATELY A LITERAL, not `hashProjection(projectSchema(getSchema(collabExtensions())))`
 * computed inline. If this constant re-derived itself from
 * `collabExtensions()` at module-eval time, `collab-schema-drift-guard.test.ts`
 * recomputing the exact same expression would always match it — the test
 * would compare a value against itself and could never fail, no matter how
 * far the schema drifted. Pinning it to a snapshot string means a schema
 * change silently breaks the drift-guard test (`SCHEMA_HASH` !==
 * recomputed), which is the whole point: CI fails, and updating this literal
 * is a one-line diff that forces the author to look at
 * `COLLAB_SCHEMA_VERSION` next to it before doing so.
 *
 * To regenerate after an intentional schema change: run the drift-guard test,
 * copy the "recomputed" value it reports on failure into this literal.
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
export const SCHEMA_HASH = 'b12f5c82';

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
