# Integration: Tiptap

This document outlines how pagespace uses the Tiptap editor to provide a rich, WYSIWYG text editing experience.

## Overview

Tiptap is a headless, framework-agnostic editor toolkit that gives us full control over the editor's appearance and behavior. We use it to power the "Rich" text editing tab in our document view.

The core implementation is a wrapper component located at [`apps/web/src/components/editors/RichEditor.tsx`](apps/web/src/components/editors/RichEditor.tsx).

## Implementation Details

### Component Wrapper & `useEditor` Hook

The [`RichEditor.tsx`](apps/web/src/components/editors/RichEditor.tsx) component is built around the `useEditor` hook. This hook is the central point for configuring the editor's extensions, content, and event handlers.

### Extensions

We use a varied set of extensions to provide a robust editing experience:

*   **`StarterKit`**: Basic blocks (paragraphs, bold, italic, headings 1-3) with `codeBlock: false`.
*   **`CodeBlockShiki`**: Custom syntax highlighting for code blocks.
*   **`Markdown`**: (Conditional) Enabled when `contentMode === 'markdown'`.
*   **`Placeholder`**: Displays "Start writing..." when empty.
*   **`TextStyleKit` & `FontFormatting`**: Text styling capabilities.
*   **`TableKit`**: Comprehensive table support.
*   **`CharacterCount`**: Tracks document size.
*   **`PageMention`**: System for referencing other pages (`@Page Title`).
*   **`PaginationPlus`**: (Conditional) Adds visual page breaks and layout for paginated views (e.g. US Letter).

### State Management

Tiptap is a controlled component in our architecture:

1.  **Initialization:** Receives initial content from `value` prop.
2.  **Updates:** On every change (`onUpdate`), we serialize the content immediately.
    *   **HTML Mode:** `editor.getHTML()`
    *   **Markdown Mode:** Uses Markdown storage serialization.
3.  **Debounce:** The parent `DocumentView` handles the 1000ms save debounce. Tiptap notifies the parent immediately via `onChange`.

### UI Components

Since Tiptap is headless, we build our own UI menus:

#### BubbleMenu
Appears on text selection.
*   **Formatting:** Bold, Italic, Strikethrough, Code.
*   **Headings:** H1, H2, H3.

#### FloatingMenu
Appears on empty lines when typing `/`.
*   **Headings:** H1, H2, H3.
*   **Blocks:** Paragraph, Bullet List, Ordered List, Blockquote.

### Read-Only Support
The component creates a seamless read-only experience by disabling editing, hiding menus, and removing focus outlines, while still allowing text selection and copying.