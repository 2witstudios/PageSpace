import { ReactRenderer } from '@tiptap/react';
import { Mention } from '@tiptap/extension-mention';
import { useDriveStore } from '@/hooks/useDrive';
import { MentionSuggestion, PageMentionData } from '@/types/mentions';
import tippy, { Instance } from 'tippy.js';
import React, { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { cn } from '@/lib/utils';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TAB_TYPES, type TabType } from '@/components/mentions/MentionPicker';

interface SuggestionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}


interface TiptapSuggestionListProps {
  items: MentionSuggestion[];
  command: (item: MentionSuggestion) => void;
}

const TiptapSuggestionList = forwardRef<SuggestionListRef, TiptapSuggestionListProps>(function TiptapSuggestionList(props, ref) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<TabType>('all');

  const items = props.items.filter(item => TAB_TYPES[activeTab].includes(item.type));

  useEffect(() => setSelectedIndex(0), [props.items, activeTab]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (items.length === 0) return false;

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        setSelectedIndex((i) => (i + items.length - 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        setSelectedIndex((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        const item = items[selectedIndex];
        if (item) props.command(item);
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        return false;
      }

      return false;
    },
  }));

  return (
    <div className="bg-popover border border-border rounded-md shadow-md overflow-hidden min-w-64 max-w-sm">
      <Tabs
        value={activeTab}
        onValueChange={(v) => { setActiveTab(v as TabType); setSelectedIndex(0); }}
      >
        <TabsList className="w-full grid grid-cols-4 h-auto p-1 bg-muted/30">
          <TabsTrigger value="all" className="text-xs">All</TabsTrigger>
          <TabsTrigger value="people" className="text-xs">People</TabsTrigger>
          <TabsTrigger value="pages" className="text-xs">Pages</TabsTrigger>
          <TabsTrigger value="groups" className="text-xs">Groups</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="max-h-64 overflow-y-auto overscroll-contain">
        {items.length === 0 ? (
          <div className="p-3 text-sm text-muted-foreground">No results found</div>
        ) : (
          <ul role="listbox">
            {items.map((item, index) => {
              const isGroup = item.type === 'everyone' || item.type === 'role';
              return (
                <li
                  key={`${item.id}-${index}`}
                  role="option"
                  aria-selected={index === selectedIndex}
                  onClick={() => props.command(item)}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={cn(
                    'px-3 py-2 cursor-pointer flex items-center gap-2',
                    'hover:bg-muted/50 transition-colors',
                    index === selectedIndex && 'bg-muted/50',
                  )}
                >
                  {isGroup && (
                    <span className="text-xs font-bold text-white bg-indigo-500 rounded px-1 py-0.5 shrink-0">
                      @
                    </span>
                  )}
                  <span className={cn(
                    'text-sm font-medium',
                    isGroup ? 'text-indigo-600 dark:text-indigo-400' : 'text-foreground',
                  )}>
                    {item.label}
                  </span>
                  {!isGroup && (
                    <span className="text-xs text-muted-foreground ml-auto">{item.type}</span>
                  )}
                  {item.description && (
                    <span className="text-xs text-muted-foreground truncate">{item.description}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
});

interface MentionAttrs {
  id: string;
  label: string;
  driveId: string | null;
  driveSlug: string | null;
  mentionType: string;
}

function getMentionAttrs(attrs: Record<string, unknown>): MentionAttrs {
  return {
    id: typeof attrs.id === 'string' ? attrs.id : '',
    label: typeof attrs.label === 'string' ? attrs.label : '',
    driveId: typeof attrs.driveId === 'string' ? attrs.driveId : null,
    driveSlug: typeof attrs.driveSlug === 'string' ? attrs.driveSlug : null,
    mentionType: typeof attrs.mentionType === 'string' ? attrs.mentionType : 'page',
  };
}

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
 * Where a click on a page mention goes, in the editor's node view.
 *
 * With a driveId, the direct dashboard URL. Without one — the AI-authored shape
 * carries `data-page-id` and nothing else — the `/p/{pageId}` resolver, which
 * exists precisely so "mentions [can] link directly to a page ID without
 * knowing the driveId" (`app/p/[pageId]/page.tsx`). Null when there is no id,
 * so the chip simply does not navigate, rather than following the bare
 * `/dashboard/` this used to fall back to, which landed on the dashboard root
 * instead of the mentioned page.
 *
 * Deliberately NOT used by `renderHTML`. That output is stored and published,
 * and `neutralizeDashboardLinks` (`packages/lib/src/publish/`) makes a mention
 * inert on a published page by rewriting hrefs that start with `/dashboard/`.
 * A `/p/{pageId}` href would slip past it and publish as a live link into an
 * auth-gated route, so stored HTML gets the dashboard href or no href at all.
 */
function pageMentionNavigationHref(id: string, driveId: string | null): string | null {
  if (!id) {
    return null;
  }
  return driveId ? `/dashboard/${driveId}/${id}` : `/p/${id}`;
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

function dispatchInternalNavigation(href: string): void {
  const event = new CustomEvent('pagespace:navigate', {
    detail: { href },
    bubbles: true,
    cancelable: true
  });
  document.dispatchEvent(event);
}

const PageMentionNode = Mention.extend({
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

  addNodeView() {
    return ({ node }: { node: { attrs: { [key: string]: unknown } } }) => {
      const { mentionType, id, label, driveId } = getMentionAttrs(node.attrs);
      const isGroup = mentionType === 'everyone' || mentionType === 'role';

      if (isGroup) {
        const dom = document.createElement('span');
        dom.className = 'mention mention--group';
        dom.contentEditable = 'false';
        dom.setAttribute('data-mention-type', mentionType);
        if (mentionType === 'role') dom.setAttribute('data-role-id', id);
        if (driveId) dom.setAttribute('data-drive-id', driveId);
        dom.textContent = `@${label}`;
        dom.addEventListener('mousedown', (event) => { event.preventDefault(); });
        return { dom, contentDOM: null };
      }

      // A user mention has no page to navigate to. It used to build
      // `/dashboard/{driveId}/{userId}`, which resolves to nothing — match
      // renderHTML and emit an inert chip carrying `data-user-id`.
      if (mentionType === 'user') {
        const dom = document.createElement('a');
        dom.className = 'mention';
        dom.contentEditable = 'false';
        dom.setAttribute('data-mention-type', 'user');
        dom.setAttribute('data-user-id', id);
        if (driveId) dom.setAttribute('data-drive-id', driveId);
        dom.textContent = `@${label}`;
        dom.addEventListener('mousedown', (event) => { event.preventDefault(); });
        return { dom, contentDOM: null };
      }

      const dom = document.createElement('a');
      const href = pageMentionNavigationHref(id, driveId);

      // NO target="_blank" - stays in WebView on Capacitor
      if (href) dom.href = href;
      dom.rel = 'noopener noreferrer nofollow';
      dom.className = 'mention';
      dom.contentEditable = 'false';
      dom.setAttribute('data-mention-type', 'page');
      dom.setAttribute('data-page-id', id);
      dom.textContent = `@${label}`;

      if (href) {
        dom.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          dispatchInternalNavigation(href);
        });
      }
      dom.addEventListener('mousedown', (event) => { event.preventDefault(); });

      return { dom, contentDOM: null };
    };
  },
});

export const PageMention = PageMentionNode.configure({
  HTMLAttributes: {
    class: 'mention',
    contenteditable: 'false',
  },
  renderHTML({ options, node }) {
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
  },
  suggestion: {
    allowSpaces: true,
    items: async ({ query }) => {
      const { currentDriveId } = useDriveStore.getState();
      if (!currentDriveId) return [];

      const types = ['page', 'user', 'everyone', 'role'].join(',');
      const url = `/api/mentions/search?q=${encodeURIComponent(query)}&driveId=${encodeURIComponent(currentDriveId)}&types=${types}`;
      const response = await fetchWithAuth(url);
      const suggestions: MentionSuggestion[] = await response.json();
      return suggestions;
    },
    render: () => {
      let component: ReactRenderer<SuggestionListRef>;
      let popup: Instance | null;

      return {
        onStart: (props) => {
          component = new ReactRenderer(TiptapSuggestionList, {
            props: {
              items: props.items,
              command: (item: MentionSuggestion) => {
                const { drives } = useDriveStore.getState();
                const isGroup = item.type === 'everyone' || item.type === 'role';
                const itemDriveId = isGroup
                  ? (item.data as { driveId: string }).driveId
                  : (item.data as PageMentionData).driveId;
                const drive = drives.find(d => d.id === itemDriveId);
                const { editor, range } = props;
                editor
                  .chain()
                  .focus()
                  .deleteRange(range)
                  .insertContent([
                    {
                      type: 'pageMention',
                      attrs: {
                        id: item.id,
                        label: item.label,
                        driveId: itemDriveId,
                        driveSlug: drive?.slug || '',
                        mentionType: item.type,
                      },
                    },
                    { type: 'text', text: '\u00A0' },
                  ])
                  .run();
              },
            },
            editor: props.editor,
          });

          if (!props.clientRect) return;
          const rect = props.clientRect();
          if (!rect) return;

          popup = tippy(document.body, {
            getReferenceClientRect: () => rect,
            appendTo: () => document.body,
            content: component.element,
            showOnCreate: true,
            interactive: true,
            trigger: 'manual',
            placement: 'bottom-start',
          }) as Instance;
        },
        onUpdate(props) {
          component.updateProps({
            items: props.items,
            command: (item: MentionSuggestion) => {
              const { drives } = useDriveStore.getState();
              const isGroup = item.type === 'everyone' || item.type === 'role';
              const itemDriveId = isGroup
                ? (item.data as { driveId: string }).driveId
                : (item.data as PageMentionData).driveId;
              const drive = drives.find(d => d.id === itemDriveId);
              const { editor, range } = props;
              editor
                .chain()
                .focus()
                .deleteRange(range)
                .insertContent([
                  {
                    type: 'pageMention',
                    attrs: {
                      id: item.id,
                      label: item.label,
                      driveId: itemDriveId,
                      driveSlug: drive?.slug || '',
                      mentionType: item.type,
                    },
                  },
                  { type: 'text', text: '\u00A0' },
                ])
                .run();
            },
          });

          const rect = props.clientRect ? props.clientRect() : null;
          if (!popup && rect) {
            popup = tippy(document.body, {
              getReferenceClientRect: () => rect,
              appendTo: () => document.body,
              content: component.element,
              showOnCreate: true,
              interactive: true,
              trigger: 'manual',
              placement: 'bottom-start',
            }) as Instance;
          } else if (popup && rect) {
            popup.setProps({ getReferenceClientRect: () => rect });
          }
        },
        onKeyDown(props) {
          if (props.event.key === 'Escape') {
            popup?.hide();
            return true;
          }
          return component.ref?.onKeyDown(props) || false;
        },
        onExit() {
          popup?.destroy();
          component.destroy();
        },
      };
    },
  },
});