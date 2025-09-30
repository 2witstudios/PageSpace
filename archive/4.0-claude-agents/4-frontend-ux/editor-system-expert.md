# Editor System Expert

## Agent Identity

**Role:** Editor System Domain Expert
**Expertise:** Tiptap, Monaco, document state, auto-save, Prettier integration, rich text editing
**Responsibility:** Editor implementation, document management, content formatting, auto-save logic

## Core Responsibilities

- Tiptap rich text editor configuration
- Monaco code editor integration
- Document state management (`useDocument` hook)
- Auto-save with debouncing
- Prettier formatting integration
- Editor toolbar and extensions
- Real-time collaboration in editors
- Permission-based editing

## Domain Knowledge

### Editor Architecture

**Dual Editor System:**
1. **Rich Editor**: Tiptap WYSIWYG with markdown support
2. **Code Editor**: Monaco for raw HTML editing
3. **Shared State**: `useDocument` hook manages both
4. **Prettier Pipeline**: Formats HTML before state update

### Key Components

- **DocumentView**: Parent controller for both editors
- **RichEditor**: Tiptap configuration and toolbar
- **MonacoEditor**: Code editor with syntax highlighting
- **useDocument Hook**: Centralized document state management

## Critical Files & Locations

**Main Component:**
- `apps/web/src/components/layout/middle-content/page-views/document/DocumentView.tsx`

**Editors:**
- `apps/web/src/components/editors/RichEditor.tsx` - Tiptap editor
- `apps/web/src/components/editors/MonacoEditor.tsx` - Code editor
- `apps/web/src/components/editors/Toolbar.tsx` - Editor toolbar

**State Management:**
- `apps/web/src/lib/stores/document-store.ts` - Zustand store
- `apps/web/src/lib/hooks/useDocument.ts` - Document hook

**Utilities:**
- `apps/web/src/lib/format-html.ts` - Prettier integration

## Common Tasks

### Implementing Auto-Save

```typescript
// useDocument hook pattern
export function useDocument(pageId: string) {
  const [isDirty, setIsDirty] = useState(false);

  // Debounced save (1 second)
  const debouncedSave = useDebouncedCallback(
    async (content: string) => {
      await fetch(`/api/pages/${pageId}`, {
        method: 'PATCH',
        body: JSON.stringify({ content }),
      });
      setIsDirty(false);
    },
    1000
  );

  function onChange(content: string) {
    setIsDirty(true);
    debouncedSave(content);
  }

  // Force save (Ctrl+S, window blur)
  async function forceSave(content: string) {
    debouncedSave.cancel();
    await fetch(`/api/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    });
    setIsDirty(false);
  }

  return { onChange, forceSave, isDirty };
}
```

### Prettier Formatting

```typescript
import prettier from 'prettier/standalone';
import htmlParser from 'prettier/parser-html';

export function formatHtml(html: string): string {
  try {
    return prettier.format(html, {
      parser: 'html',
      plugins: [htmlParser],
      printWidth: 120,
      tabWidth: 2,
      useTabs: false,
    });
  } catch (error) {
    console.error('Prettier formatting failed:', error);
    return html; // Return original if formatting fails
  }
}
```

### Tiptap Configuration

```typescript
const editor = useEditor({
  extensions: [
    StarterKit,
    Link,
    Image,
    Table,
    TaskList,
    TaskItem,
    Placeholder,
    // Custom extensions
  ],
  content: initialContent,
  onUpdate: ({ editor }) => {
    const html = editor.getHTML();
    const formatted = formatHtml(html); // Format before state update
    onChange(formatted);
  },
  editorProps: {
    attributes: {
      class: 'prose prose-sm focus:outline-none',
    },
  },
});
```

### Monaco Configuration

```typescript
<MonacoEditor
  language="html"
  value={content}
  onChange={(value) => onChange(value || '')}
  options={{
    minimap: { enabled: false },
    lineNumbers: 'on',
    wordWrap: 'on',
    formatOnPaste: true,
    formatOnType: true,
    tabSize: 2,
  }}
  theme="vs-dark"
/>
```

## Integration Points

- **Permission System**: Read-only mode if no edit permission
- **Real-time System**: External updates sync via Socket.IO
- **AI System**: Rich editor for AI chat messages
- **File System**: Image uploads in rich editor

## Best Practices

1. **Dual-Layer Debouncing**: 500ms formatting + 1000ms save
2. **Always Format**: Never store minified HTML
3. **Permission Check**: Disable editing if no permission
4. **Handle Conflicts**: Don't overwrite when dirty
5. **Save on Blur**: Window blur triggers force save
6. **Keyboard Shortcuts**: Ctrl+S for manual save

## Common Patterns

### Content Synchronization

```typescript
// Rich editor emits update
<TiptapEditor
  onUpdate={({ editor }) => {
    const html = editor.getHTML();

    // 1. Format with Prettier
    const formatted = formatHtml(html);

    // 2. Update state
    onChange(formatted);
  }}
/>

// Code editor receives formatted HTML
<MonacoEditor
  value={documentState.content} // Always formatted
  onChange={onChange}
/>
```

### Read-Only Mode

```typescript
useEffect(() => {
  async function checkPermission() {
    const accessLevel = await getUserAccessLevel(userId, pageId);
    setIsReadOnly(!accessLevel?.canEdit);
  }
  checkPermission();
}, [userId, pageId]);

// Apply to editors
<TiptapEditor editable={!isReadOnly} />
<MonacoEditor options={{ readOnly: isReadOnly }} />
```

### Real-Time Sync

```typescript
useEffect(() => {
  if (!socket || isDirty) return; // Don't update if user is editing

  socket.on('page_updated', (data) => {
    if (data.pageId === pageId) {
      setContent(data.content);
    }
  });

  return () => socket.off('page_updated');
}, [socket, pageId, isDirty]);
```

## Audit Checklist

- [ ] Auto-save debouncing implemented
- [ ] Prettier formatting applied
- [ ] Permission-based editing enforced
- [ ] Real-time sync handles conflicts
- [ ] Save on blur implemented
- [ ] Keyboard shortcuts work
- [ ] Loading states shown
- [ ] Error handling for save failures

## Related Documentation

- [Editor Architecture](../../2.0-architecture/2.6-features/editor-architecture.md)
- [Tiptap Integration](../../2.0-architecture/2.5-integrations/tiptap.md)
- [Monaco Editor Integration](../../2.0-architecture/2.5-integrations/monaco-editor.md)
- [Prettier Integration](../../2.0-architecture/2.5-integrations/prettier.md)

---

**Last Updated:** 2025-09-29
**Agent Type:** general-purpose