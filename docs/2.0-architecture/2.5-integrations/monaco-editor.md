# Integration: Monaco Editor

This document outlines how pagespace uses the Monaco Editor, the code editor that powers VS Code, to provide a rich code editing experience.

## Overview

Monaco Editor is used to power the "Code" tab within our document view. It provides a professional-grade editing experience with features like syntax highlighting, line numbers, and a minimap. Its primary role is to display and allow editing of the raw HTML content of a page.

The core implementation is a wrapper component located at [`apps/web/src/components/editors/MonacoEditor.tsx`](apps/web/src/components/editors/MonacoEditor.tsx:1).

## Implementation Details

### Component Wrapper

The [`MonacoEditor.tsx`](apps/web/src/components/editors/MonacoEditor.tsx:1) component is a comprehensive wrapper around the `@monaco-editor/react` library. It's configured to be a controlled component, receiving its content and callbacks via props.

**Props Interface:**
-   `value`: The content string to display in the editor.
-   `onChange`: A callback function that is invoked whenever the content in the editor changes.
-   `readOnly`: Optional boolean to enable read-only mode with optimized UX.
-   `language`: The language for syntax highlighting, defaults to `"markdown"`.

**Key Features:**
- **Read-only Mode**: When `readOnly` is true, the editor provides an optimized read-only experience with disabled cursor, drag-and-drop, and line highlighting while preserving context menus, hover tooltips, and selection for copying.
- **Enhanced Editor Options**: Includes minimap, word wrap, syntax highlighting, line numbers, folding, and optimized scrollbar configuration.
- **Professional UX**: Font size of 16px, enabled glyph margin, and copy with syntax highlighting for better user experience.

### State Management

The Monaco Editor does not manage its own persistent state. It receives the page content directly from its parent component, [`DocumentView.tsx`](apps/web/src/components/layout/middle-content/page-views/document/DocumentView.tsx:1), via the `value` prop. When a user types in the Monaco Editor, the `onChange` event fires, which updates the shared state in `DocumentView`.

### Web Worker Configuration

A critical piece of the implementation is the `useEffect` hook that configures the paths for Monaco's web workers. Because Next.js bundles dependencies in a specific way, we must explicitly tell Monaco where to find its worker files for different languages (HTML, CSS, JS/TS). This ensures that features like syntax analysis and validation work correctly.

```typescript
// apps/web/src/components/editors/MonacoEditor.tsx
useEffect(() => {
  if (typeof window !== 'undefined') {
    window.MonacoEnvironment = {
      getWorkerUrl: (_moduleId: string, label: string) => {
        if (label === 'json') return '/_next/static/json.worker.js';
        if (label === 'css') return '/_next/static/css.worker.js';
        if (label === 'html') return '/_next/static/html.worker.js';
        if (label === 'typescript' || label === 'javascript')
          return '/_next/static/ts.worker.js';
        return '/_next/static/editor.worker.js';
      },
    };
  }
}, []);
```

### Editor Configuration

The component includes comprehensive editor options:

```typescript
options={{
  readOnly,
  domReadOnly: readOnly,
  cursorWidth: readOnly ? 0 : undefined,
  contextmenu: true, // Allow context menu even in read-only for copying
  columnSelection: true, // Allow column selection for copying
  dragAndDrop: !readOnly,
  hover: readOnly ? { enabled: true } : undefined, // Keep hover for tooltips
  readOnlyMessage: readOnly ? { value: "" } : undefined,
  selectOnLineNumbers: true, // Allow line selection
  copyWithSyntaxHighlighting: true, // Better copy experience
  minimap: { enabled: true },
  wordWrap: 'on',
  scrollBeyondLastLine: false,
  fontSize: 16,
  lineNumbers: 'on',
  glyphMargin: true,
  folding: true,
  lineDecorationsWidth: 10,
  lineNumbersMinChars: 3,
  renderLineHighlight: readOnly ? 'none' : 'line',
  scrollbar: {
    vertical: 'auto',
    horizontal: 'auto'
  },
}}
```

**Last Updated:** 2025-08-21