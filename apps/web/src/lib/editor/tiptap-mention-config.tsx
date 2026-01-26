import { ReactRenderer } from '@tiptap/react';
import { Mention } from '@tiptap/extension-mention';
import { useDriveStore } from '@/hooks/useDrive';
import { MentionSuggestion, PageMentionData } from '@/types/mentions';
import tippy, { Instance } from 'tippy.js';
import React, { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

interface SuggestionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}


interface TiptapSuggestionListProps {
  items: MentionSuggestion[];
  command: (item: MentionSuggestion) => void;
}

// Simple suggestion list component for Tiptap mentions
const TiptapSuggestionList = forwardRef<SuggestionListRef, TiptapSuggestionListProps>(function TiptapSuggestionList(props, ref) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const selectItem = (index: number) => {
    console.log('[TiptapSuggestionList] selectItem called with index:', index);
    console.log('[TiptapSuggestionList] items count:', props.items.length);
    
    if (props.items.length === 0) {
      console.log('[TiptapSuggestionList] No items to select');
      return;
    }
    
    const item = props.items[index];
    console.log('[TiptapSuggestionList] Selected item:', item);
    
    if (item) {
      console.log('[TiptapSuggestionList] Calling command with selected item');
      props.command(item);
    }
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      console.log('[TiptapSuggestionList] onKeyDown called with key:', event.key);
      console.log('[TiptapSuggestionList] Current selectedIndex:', selectedIndex);
      console.log('[TiptapSuggestionList] Items length:', props.items.length);
      
      // Don't handle keys if no items available
      if (props.items.length === 0) {
        console.log('[TiptapSuggestionList] No items available, not handling key');
        return false;
      }
      
      // Prevent default behavior and stop propagation for handled keys
      if (event.key === 'ArrowUp') {
        console.log('[TiptapSuggestionList] Handling ArrowUp');
        event.preventDefault();
        event.stopPropagation();
        const newIndex = (selectedIndex + props.items.length - 1) % props.items.length;
        console.log('[TiptapSuggestionList] Setting selectedIndex to:', newIndex);
        setSelectedIndex(newIndex);
        return true;
      }
      if (event.key === 'ArrowDown') {
        console.log('[TiptapSuggestionList] Handling ArrowDown');
        event.preventDefault();  
        event.stopPropagation();
        const newIndex = (selectedIndex + 1) % props.items.length;
        console.log('[TiptapSuggestionList] Setting selectedIndex to:', newIndex);
        setSelectedIndex(newIndex);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        console.log('[TiptapSuggestionList] Handling Enter/Tab - calling selectItem');
        event.preventDefault();
        event.stopPropagation();
        selectItem(selectedIndex);
        return true;
      }
      if (event.key === 'Escape') {
        console.log('[TiptapSuggestionList] Handling Escape - letting parent handle');
        event.preventDefault();
        event.stopPropagation();
        // Let the parent handle escape (will trigger cleanup)
        return false; 
      }
      
      console.log('[TiptapSuggestionList] Key not handled:', event.key);
      return false;
    },
  }));

  useEffect(() => setSelectedIndex(0), [props.items]);

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg min-w-48 max-w-sm">
      {props.items.length ? (
        <ul className="max-h-60 overflow-y-auto">
          {props.items.map((item, index) => (
            <li
              key={item.id}
              className={`px-3 py-2 cursor-pointer transition-colors duration-150 ease-in-out hover:bg-gray-100 hover:dark:bg-gray-700 ${
                index === selectedIndex ? 'bg-gray-100 dark:bg-gray-700 border-l-2 border-blue-500' : ''
              }`}
              onClick={() => selectItem(index)}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {item.label}
                </span>
                <span className="text-xs text-gray-500 ml-auto">
                  {item.type}
                </span>
              </div>
              {item.description && (
                <div className="text-xs text-gray-500 mt-1 truncate">
                  {item.description}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="p-3 text-sm text-gray-500">No results found</div>
      )}
    </div>
  );
});

/**
 * Dispatch a navigation event for internal links
 * This allows parent React components to handle navigation with router.push()
 */
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
    };
  },

  addNodeView() {
    return ({ node }: { node: { attrs: { id: string; label: string; driveId: string; driveSlug: string } } }) => {
      const dom = document.createElement('a');
      const href = node.attrs.driveId
        ? `/dashboard/${node.attrs.driveId}/${node.attrs.id}`
        : `/dashboard/`;

      // Set up link attributes - NO target="_blank" to stay in WebView on Capacitor
      dom.href = href;
      dom.rel = 'noopener noreferrer nofollow';
      dom.className = 'mention';
      dom.contentEditable = 'false';
      dom.setAttribute('data-mention-type', 'page');
      dom.setAttribute('data-page-id', node.attrs.id);

      // Set content
      dom.textContent = `@${node.attrs.label}`;

      // Handle click events - dispatch navigation event for React router handling
      // Falls back to window.location for non-React contexts
      dom.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        // Dispatch event for parent component to handle with router.push()
        dispatchInternalNavigation(href);
      });

      // Prevent selection on click
      dom.addEventListener('mousedown', (event) => {
        event.preventDefault();
      });

      return {
        dom,
        contentDOM: null, // No content DOM since this is atomic
      };
    };
  },
});

export const PageMention = PageMentionNode.configure({
  HTMLAttributes: {
    class: 'mention',
    contenteditable: 'false',
  },
  renderHTML({ options, node }) {
    const href = node.attrs.driveId
      ? `/dashboard/${node.attrs.driveId}/${node.attrs.id}`
      : `/dashboard/`;
    return [
      'a',
      {
        ...options.HTMLAttributes,
        href: href,
        // NO target="_blank" - stays in WebView on Capacitor iOS
        rel: 'noopener noreferrer nofollow',
        'data-mention-type': 'page',
        'data-page-id': node.attrs.id,
        contenteditable: 'false',
      },
      `@${node.attrs.label}`,
    ];
  },
  suggestion: {
    items: async ({ query }) => {
      console.log('[TipTap] items called with query:', query);
      const { currentDriveId } = useDriveStore.getState();
      console.log('[TipTap] currentDriveId:', currentDriveId);
      
      if (!currentDriveId) {
        console.log('[TipTap] No currentDriveId, returning empty array');
        return [];
      }

      const types = ['page', 'user'].join(',');
      const url = `/api/mentions/search?q=${query}&driveId=${currentDriveId}&types=${types}`;
      console.log('[TipTap] Fetching suggestions from:', url);
      
      const response = await fetchWithAuth(url);
      const suggestions: MentionSuggestion[] = await response.json();
      console.log('[TipTap] Got suggestions:', suggestions);
      
      return suggestions;
    },
    render: () => {
      let component: ReactRenderer<SuggestionListRef>;
      let popup: Instance | null;

      return {
        onStart: (props) => {
          console.log('[TipTap] onStart called with props:', props);
          console.log('[TipTap] items count:', props.items?.length || 0);
          
          component = new ReactRenderer(TiptapSuggestionList, {
            props: {
              items: props.items,
              command: (item: MentionSuggestion) => {
                console.log('[TipTap] command called with item:', item);
                const { drives } = useDriveStore.getState();
                const drive = drives.find(d => d.id === (item.data as PageMentionData).driveId);
                
                console.log('[TipTap] Executing mention insertion command');
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
                        driveId: (item.data as PageMentionData).driveId,
                        driveSlug: drive?.slug || '',
                      },
                    },
                    {
                      type: 'text',
                      text: '\u00A0', // Add a non-breaking space right after
                    },
                  ])
                  .run();
                
                console.log('[TipTap] Mention insertion command completed');
              },
            },
            editor: props.editor,
          });

          if (!props.clientRect) {
            return;
          }

          const rect = props.clientRect ? props.clientRect() : null;
          if (!rect) {
            console.log('[TipTap] No clientRect, aborting popup creation');
            return;
          }

          console.log('[TipTap] Creating tippy popup at rect:', rect);
          popup = tippy(document.body, {
            getReferenceClientRect: () => rect,
            appendTo: () => document.body,
            content: component.element,
            showOnCreate: true,
            interactive: true,
            trigger: 'manual',
            placement: 'bottom-start',
          }) as Instance;
          console.log('[TipTap] Tippy popup created');
        },
        onUpdate(props) {
          console.log('[TipTap] onUpdate called with props:', props);
          console.log('[TipTap] updated items count:', props.items?.length || 0);
          
          component.updateProps({
            items: props.items,
            command: (item: MentionSuggestion) => {
              const { drives } = useDriveStore.getState();
              const drive = drives.find(d => d.id === (item.data as PageMentionData).driveId);
              
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
                      driveId: (item.data as PageMentionData).driveId,
                      driveSlug: drive?.slug || '',
                    },
                  },
                  {
                    type: 'text',
                    text: '\u00A0', // Add a non-breaking space right after
                  },
                ])
                .run();
            },
          });
          
          const rect = props.clientRect ? props.clientRect() : null;
          if (popup && rect) {
            popup.setProps({
              getReferenceClientRect: () => rect,
            });
          }
        },
        onKeyDown(props) {
          console.log('[TipTap] onKeyDown called with key:', props.event.key);
          
          if (props.event.key === 'Escape') {
            console.log('[TipTap] Escape pressed, hiding popup');
            popup?.hide();
            return true;
          }
          
          const handled = component.ref?.onKeyDown(props) || false;
          console.log('[TipTap] Key handled by component:', handled);
          return handled;
        },
        onExit() {
          console.log('[TipTap] onExit called, cleaning up');
          popup?.destroy();
          component.destroy();
        },
      };
    },
  },
});