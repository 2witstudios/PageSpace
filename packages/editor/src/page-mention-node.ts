import { Mention, type MentionOptions } from '@tiptap/extension-mention';
import type { DOMOutputSpec } from '@tiptap/pm/model';

/**
 * The `pageMention` node's schema-affecting shape only: attributes and the
 * HTML parse rules that decide which stored dialect a mention round-trips
 * through. No `addNodeView` (touches `document.createElement`) and no
 * suggestion UI (tippy/React/fetch) — those are client-only and live on
 * `PageMention` in `tiptap-mention-config.tsx`, which extends this node.
 * `collabExtensions()` uses this node directly so the frozen schema can be
 * constructed in Node with no DOM.
 *
 * `parseHTML`/`renderHTML` below are plain functions ProseMirror calls with
 * an explicit element/attrs argument — they never touch the global
 * `document`/`window`, so they are safe to keep here even though this module
 * must construct without a DOM.
 */

/**
 * The mention HTML dialects that exist in stored `pages.content` today, and
 * which `parseHTML` below has to accept all of.
 *
 * 1. Editor-written. `renderHTML` emitted the node's attributes under their
 *    literal names as well as the `data-*` forms, so old content carries
 *    `id="…" label="…" driveid="…" driveslug="…" mentiontype="…"` alongside
 *    `data-page-id` / `data-mention-type`. Those literal attributes are no
 *    longer emitted — `id` in particular collided with real DOM ids — but they
 *    are still parsed, or every mention written before this change loses its
 *    attributes.
 * 2. Group spans. `<span data-mention-type="everyone|role">` with `data-role-id`
 *    and `data-drive-id`.
 * 3. AI-written. `lib/ai/skills/bodies/writing-documents.ts` instructs models to
 *    write `<a class="mention" data-mention-type="page" data-page-id="ID">@Title</a>`
 *    — no `data-type`, no `href`, no label attribute. `label` therefore falls
 *    back to the element's text and `driveId` to the `href` path.
 *
 * Before this, none of the `<a>` forms parsed at all: the inherited rule matched
 * only `span[data-type="pageMention"]`, so a page mention fell through to
 * StarterKit's `link` mark and re-rendered without `data-page-id` — the exact
 * selector `syncMentions` (`services/api/page-mention-service.ts:61`) matches.
 * Round-tripping a document therefore deleted its mention graph.
 *
 * The readers below are what accept all three; `parseHTML` picks the elements.
 */

const MENTION_TEXT_PREFIX = /^@/;

/**
 * First non-empty attribute, or null. Empty rather than absent is the common
 * case in stored content: `renderHTML` writes `data-drive-id={driveId ?? ''}`
 * and `data-page-id={id}` where `id` defaults to `''`, so a mention with no
 * drive carries `data-drive-id=""`. Reading that back as `''` instead of null
 * would put a meaningless non-default value on every such attribute.
 */
function readAttr(element: HTMLElement, ...names: string[]): string | null {
  for (const name of names) {
    const value = element.getAttribute(name);
    if (value) {
      return value;
    }
  }
  return null;
}

function readLabel(element: HTMLElement): string | null {
  const explicit = readAttr(element, 'label');
  if (explicit) {
    return explicit;
  }
  // One leading '@' only, so a label that is itself '@channel' survives.
  const text = element.textContent?.trim().replace(MENTION_TEXT_PREFIX, '');
  return text ? text : null;
}

/** `/dashboard/{driveId}/{pageId}` — the only href shape `renderHTML` produces. */
function readDriveIdFromHref(element: HTMLElement): string | null {
  const href = element.getAttribute('href');
  const match = href?.match(/^\/dashboard\/([^/]+)\/[^/]+$/);
  return match?.[1] ?? null;
}

/**
 * `data-mention-type` when it is there, otherwise inferred from whichever
 * identity attribute is present. `syncMentions` selects on `a[data-page-id]`
 * and `a[data-user-id]` alone, so content written against that contract can
 * carry an id with no type — and defaulting such an anchor to 'page' would
 * file a user id as a page id, which is the bug this fix exists to remove.
 */
function readMentionType(element: HTMLElement): string {
  const explicit = readAttr(element, 'data-mention-type', 'mentiontype');
  if (explicit) {
    return explicit;
  }
  if (readAttr(element, 'data-user-id')) {
    return 'user';
  }
  if (readAttr(element, 'data-role-id')) {
    return 'role';
  }
  return 'page';
}

/**
 * The identity attribute is per mention type: a page mention's id lives in
 * `data-page-id`, a user's in `data-user-id`, a role's in `data-role-id`. An
 * `everyone` mention has no id.
 */
function readMentionId(element: HTMLElement): string | null {
  return readAttr(element, 'data-page-id', 'data-user-id', 'data-role-id', 'id');
}

function getMentionAttrs(attrs: Record<string, unknown>) {
  return {
    id: typeof attrs.id === 'string' ? attrs.id : '',
    label: typeof attrs.label === 'string' ? attrs.label : '',
    driveId: typeof attrs.driveId === 'string' ? attrs.driveId : null,
    driveSlug: typeof attrs.driveSlug === 'string' ? attrs.driveSlug : null,
    mentionType: typeof attrs.mentionType === 'string' ? attrs.mentionType : 'page',
  };
}

const PageMentionExtension = Mention.extend({
  name: 'pageMention',

  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    // Every attribute renders as `{}` because the node's own renderHTML below
    // emits the `data-*` forms itself. Without this, TipTap falls back to
    // emitting each attribute under its literal name (core's
    // `getRenderedAttributes`), which is where the stray `id="…" label="…"`
    // attributes in existing content came from.
    return {
      id: {
        default: null,
        parseHTML: readMentionId,
        renderHTML: () => ({}),
      },
      label: {
        default: null,
        parseHTML: readLabel,
        renderHTML: () => ({}),
      },
      driveId: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          readAttr(element, 'data-drive-id', 'driveid') ?? readDriveIdFromHref(element),
        renderHTML: () => ({}),
      },
      driveSlug: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          readAttr(element, 'data-drive-slug', 'driveslug'),
        renderHTML: () => ({}),
      },
      // 'page' | 'user' | 'everyone' | 'role'
      mentionType: {
        default: 'page',
        parseHTML: readMentionType,
        renderHTML: () => ({}),
      },
    };
  },

  /**
   * `priority: 60` beats the default 50 that StarterKit's `link` mark rule
   * (`a[href]`) carries, so a page mention's anchor is claimed by this node
   * rather than degrading to a link. Extension priority does not propagate to
   * parse rules — it only orders extensions — so it has to be set here.
   */
  parseHTML() {
    return [
      { tag: 'a[data-page-id]', priority: 60 },
      { tag: 'a[data-user-id]', priority: 60 },
      { tag: 'a[data-mention-type]', priority: 60 },
      { tag: 'span[data-mention-type]', priority: 60 },
      { tag: `span[data-type="${this.name}"]`, priority: 60 },
    ];
  },
});

/**
 * `renderHTML` picks the mention dialect (page/user/everyone/role) from node
 * attrs — schema round-trip logic, not view logic — so it is configured here,
 * on the DOM-free node, rather than deferred to the client's `PageMention`.
 * It returns a DOM-output-spec array (ProseMirror's `DOMOutputSpec`), never
 * touches `document`/`window`, and is safe to call in Node.
 */
function pageMentionRenderHTML({
  options,
  node,
}: Parameters<MentionOptions['renderHTML']>[0]): DOMOutputSpec {
  const { mentionType, id, label, driveId, driveSlug } = getMentionAttrs(node.attrs);

  // Only emitted when set, so mentions that never carried a slug gain no
  // attribute. Nothing reads it today; it is preserved because dropping a
  // schema attribute is a decision for the COLLAB_SCHEMA_VERSION v1 leaf,
  // not a side effect of a round-trip fix.
  const slugAttrs = driveSlug ? { 'data-drive-slug': driveSlug } : {};

  if (mentionType === 'everyone') {
    return [
      'span',
      {
        ...options.HTMLAttributes,
        ...slugAttrs,
        'data-mention-type': 'everyone',
        'data-drive-id': driveId ?? '',
        contenteditable: 'false',
      },
      `@${label}`,
    ];
  }

  if (mentionType === 'role') {
    return [
      'span',
      {
        ...options.HTMLAttributes,
        ...slugAttrs,
        'data-mention-type': 'role',
        'data-role-id': id,
        'data-drive-id': driveId ?? '',
        contenteditable: 'false',
      },
      `@${label}`,
    ];
  }

  // A user mention used to fall through to the page branch below, which
  // wrote the user's id into `data-page-id` — so `syncMentions` read it as a
  // page id, and the `a[data-user-id]` selector it actually looks for
  // (`page-mention-service.ts:65`) was emitted by nothing in the codebase.
  // Deliberately no `href`: there is no user route, and an anchor without one
  // cannot be claimed by the `link` mark on the way back in.
  if (mentionType === 'user') {
    return [
      'a',
      {
        ...options.HTMLAttributes,
        ...slugAttrs,
        'data-mention-type': 'user',
        'data-user-id': id,
        'data-drive-id': driveId ?? '',
        contenteditable: 'false',
      },
      `@${label}`,
    ];
  }

  // Stored HTML only ever gets the dashboard href, and only when the drive is
  // known. Without it there is no URL this output may carry: the old fallback
  // wrote a bare `/dashboard/`, which reads as a link and lands on the
  // dashboard root, and the `/p/{pageId}` resolver the node view uses would
  // slip past `neutralizeDashboardLinks` (`packages/lib/src/publish/`) and
  // publish as a live link into an auth-gated route. An href-less anchor is
  // already inert on a published page.
  const href = driveId && id ? `/dashboard/${driveId}/${id}` : null;
  return [
    'a',
    {
      ...options.HTMLAttributes,
      ...slugAttrs,
      ...(href ? { href } : {}),
      // NO target="_blank" - stays in WebView on Capacitor iOS
      rel: 'noopener noreferrer nofollow',
      'data-mention-type': 'page',
      'data-page-id': id,
      'data-drive-id': driveId ?? '',
      contenteditable: 'false',
    },
    `@${label}`,
  ];
}

/**
 * The frozen `pageMention` node: schema shape plus its HTML round-trip
 * (`renderHTML`, `HTMLAttributes`). No node view, no suggestion UI. This is
 * what `collabExtensions()` returns; `PageMention` in
 * `tiptap-mention-config.tsx` extends it with the client-only node view and
 * `.configure()`s the suggestion picker on top.
 */
export const PageMentionNode = PageMentionExtension.configure({
  HTMLAttributes: {
    class: 'mention',
    contenteditable: 'false',
  },
  renderHTML: pageMentionRenderHTML,
});

export { getMentionAttrs };
