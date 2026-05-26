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
    return {
      id: { default: null },
      label: { default: null },
      driveId: { default: null },
      driveSlug: { default: null },
      // 'page' | 'user' | 'everyone' | 'role'
      mentionType: { default: 'page' },
    };
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

      const dom = document.createElement('a');
      const href = driveId && id ? `/dashboard/${driveId}/${id}` : `/dashboard/`;

      // NO target="_blank" - stays in WebView on Capacitor
      dom.href = href;
      dom.rel = 'noopener noreferrer nofollow';
      dom.className = 'mention';
      dom.contentEditable = 'false';
      dom.setAttribute('data-mention-type', 'page');
      dom.setAttribute('data-page-id', id);
      dom.textContent = `@${label}`;

      dom.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        dispatchInternalNavigation(href);
      });
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
    const { mentionType, id, label, driveId } = getMentionAttrs(node.attrs);

    if (mentionType === 'everyone') {
      return [
        'span',
        {
          ...options.HTMLAttributes,
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
          'data-mention-type': 'role',
          'data-role-id': id,
          'data-drive-id': driveId ?? '',
          contenteditable: 'false',
        },
        `@${label}`,
      ];
    }

    const href = driveId && id ? `/dashboard/${driveId}/${id}` : `/dashboard/`;
    return [
      'a',
      {
        ...options.HTMLAttributes,
        href,
        // NO target="_blank" - stays in WebView on Capacitor iOS
        rel: 'noopener noreferrer nofollow',
        'data-mention-type': 'page',
        'data-page-id': id,
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