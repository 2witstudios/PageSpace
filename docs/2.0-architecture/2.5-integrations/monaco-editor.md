# Integration: Monaco Editor

This document outlines how pagespace uses the Monaco Editor (the core of VS Code) to provide a professional code editing experience for raw HTML and Markdown.

## Overview

Monaco Editor powers the "Code" tab within our document view. It offers a familiar developer experience with features like minimaps, multi-cursors, and syntax highlighting.

The core implementation is at [`apps/web/src/components/editors/MonacoEditor.tsx`](apps/web/src/components/editors/MonacoEditor.tsx).

## Implementation Details

### Component Wrapper

We use a controlled component wrapper around `@monaco-editor/react`.

**Props Interface:**
*   `value`: The content string (HTML or Markdown).
*   `onChange`: Callback when content changes.
*   `language`: `"html"` (default) or `"markdown"`.
*   `readOnly`: optimized read-only mode.

### Editor Configuration

We configure Monaco for a distraction-free but powerful experience:

*   **Minimap:** Enabled.
*   **Word Wrap:** On.
*   **Font Size:** 16px.
*   **Line Numbers:** On.
*   **Folding:** Enabled.
*   **Read-Only:** Optimized to hide cursor/highlights but allow selection/copy.

### Language Support

*   **HTML:** Default mode. Provides tag matching, auto-completion, and syntax coloring.
*   **Markdown:** Used when page `contentMode` is markdown.
*   **Sudolang:** We register a custom `sudolang` language definition (via `registerSudolangLanguage`) for specialized AI prompting files, ensuring they have proper syntax highlighting.

### Web Worker Configuration

To avoid dependency on external CDNs, we self-host the Monaco worker assets. The loader is configured in `apps/web/src/lib/editor/monaco/loader-config.ts` to resolve paths to `/_next/static/monaco/vs`, ensuring the editor works strictly offline/local-first.
