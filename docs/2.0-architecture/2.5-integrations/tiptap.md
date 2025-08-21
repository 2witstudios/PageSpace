# Integration: Tiptap

This document outlines how pagespace uses the Tiptap editor to provide a rich, WYSIWYG text editing experience.

## Overview

Tiptap is a headless, framework-agnostic editor toolkit that gives us full control over the editor's appearance and behavior. We use it to power the "Rich" text editing tab in our document view. It provides a user-friendly interface for creating and formatting content without needing to write raw HTML.

The core implementation is a wrapper component located at [`apps/web/src/components/editors/RichEditor.tsx`](apps/web/src/components/editors/RichEditor.tsx:1).

## Implementation Details

### Component Wrapper & `useEditor` Hook

The [`RichEditor.tsx`](apps/web/src/components/editors/RichEditor.tsx:1) component is built around the `useEditor` hook from `@tiptap/react`. This hook is the central point for configuring the editor's extensions, content, and event handlers.

The component includes support for both read-only and editable modes, with proper focus management and content synchronization.

### Extensions

We use a variety of Tiptap extensions to enable different features:

-   **`StarterKit`**: Provides the basic building blocks like paragraphs, bold, italic, headings (levels 1-3), and links with `openOnClick: true`.
-   **`Markdown`**: Allows users to use Markdown syntax that gets converted on the fly using the `tiptap-markdown` package.
-   **`Placeholder`**: Shows placeholder text ("Start writing...") when the editor is empty (disabled in read-only mode).
-   **`TextStyleKit`**: Extension for text styling capabilities.
-   **`TableKit`**: A comprehensive extension for creating and editing tables.
-   **`CharacterCount`**: Provides a character count for the document.
-   **`PageMention`**: Custom mention system for referencing pages and users (imported from `@/lib/editor/tiptap-mention-config`).

### State Management and `onUpdate`

Similar to the Monaco editor, the Tiptap editor is a controlled component.

-   It receives its initial content from the `value` prop.
-   The `onUpdate` event handler is the most critical piece of its integration. It fires every time the user makes a change in the editor.
-   Inside `onUpdate`, we call `editor.getHTML()` to get the latest HTML content from Tiptap.
-   **Crucially, this HTML is then passed to our Prettier formatting utility (`formatHtml`) before being sent to the parent component via the `onChange` callback.** This ensures clean, formatted HTML output.
-   The update process is debounced (500ms) to prevent excessive updates during rapid typing.

```typescript
// apps/web/src/components/editors/RichEditor.tsx
const debouncedOnChange = useCallback(
  (editor: Editor) => {
    if (debounceTimeout.current) {
      clearTimeout(debounceTimeout.current);
    }
    debounceTimeout.current = setTimeout(async () => {
      const html = editor.getHTML();
      const formattedHtml = await formatHtml(html);
      onChange(formattedHtml);
    }, 500);
  },
  [onChange]
);

// In useEditor configuration:
onUpdate: ({ editor }) => {
  if (!readOnly) {
    debouncedOnChange(editor);
  }
},
```

### Content Synchronization

The component includes intelligent content synchronization to prevent unnecessary updates:

- Handles empty content states (empty paragraphs vs empty strings)
- Only updates editor content when there's a meaningful difference
- Uses `emitUpdate: false` to prevent infinite update loops

### UI Components: `BubbleMenu` and `FloatingMenu`

Tiptap's headless nature means we are responsible for building the entire UI. We use two special components from Tiptap to create contextual menus:

#### BubbleMenu
-   Appears when text is selected (`from !== to`)
-   Provides formatting options: Bold, Italic, Strikethrough, Code
-   Includes heading options (H1, H2, H3)
-   Uses visual indicators to show active formatting states
-   Only visible in non-read-only mode

#### FloatingMenu
-   Triggered when user types `/` on a new line
-   Offers content insertion options:
  - Heading levels (1, 2, 3)
  - Paragraph
  - Bullet List
  - Ordered List
  - Blockquote
-   Only visible in non-read-only mode

These menus are styled with Tailwind CSS using shadcn/ui design tokens and use `lucide-react` icons.

### Read-Only Support

The component supports read-only mode with the following features:

- Disables editing capabilities
- Removes interactive menus (BubbleMenu and FloatingMenu)
- Adjusts styling (opacity, cursor, user-select)
- Automatically blurs the editor to prevent focus
- Disables the placeholder extension

### Editor Configuration

The editor includes advanced configuration options:

```typescript
editorProps: {
  attributes: {
    class: readOnly 
      ? 'tiptap m-5 cursor-text' 
      : 'tiptap m-5 focus:outline-none',
    tabindex: readOnly ? '-1' : '0',
    style: readOnly ? 'user-select: text; -webkit-user-select: text;' : '',
  },
  scrollThreshold: 80,
  scrollMargin: 80,
},
```

### Dependencies

The Tiptap integration uses the following key packages:

- `@tiptap/react`: Core React integration
- `@tiptap/starter-kit`: Basic editor functionality
- `@tiptap/extensions`: Additional extensions (Placeholder, CharacterCount)
- `@tiptap/extension-text-style`: Text styling capabilities
- `@tiptap/extension-table`: Table functionality
- `tiptap-markdown`: Markdown support
- Custom mention system for page and user references