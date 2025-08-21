# Integration: Prettier

This document outlines how pagespace uses Prettier to format HTML content, ensuring consistency between our rich text and code editors.

## Overview

Prettier is an opinionated code formatter. While it is often used as a development tool for formatting source code, we use it as a runtime library for a very specific purpose: **formatting the HTML output of the Tiptap editor.**

The primary problem this solves is that Tiptap, by default, outputs minified, single-line HTML. This makes it impossible to perform line-based diffs for version control or for our planned AI editing features. By running Tiptap's output through Prettier, we ensure the HTML is always well-formatted and multi-line.

The core implementation is a utility function located at [`apps/web/src/lib/prettier.ts`](apps/web/src/lib/prettier.ts:1).

## Implementation Details

### Standalone Usage

We use Prettier in a "standalone" mode. Instead of installing the full Prettier CLI and running it on our source code, we've added the `prettier` library as a regular dependency to our project. This allows us to import and use its formatting capabilities directly in our application code.

### The `formatHtml` Utility

The [`formatHtml`](apps/web/src/lib/prettier.ts:4) function is a simple async wrapper around Prettier's `format` function.

-   **Plugins:** It is explicitly configured to use the `prettier/plugins/html` plugin. This is crucial because Prettier needs the appropriate plugin to know how to parse and format HTML correctly.
-   **Parser:** It tells Prettier to use the `"html"` parser.
-   **Error Handling:** It includes a `try...catch` block to ensure that if Prettier ever fails to format a piece of HTML, it will log the error and return the original, unformatted HTML. This prevents the entire application from crashing due to a formatting error.

```typescript
// apps/web/src/lib/prettier.ts
import { format } from 'prettier/standalone';
import * as prettierPluginHtml from 'prettier/plugins/html';

export const formatHtml = async (html: string): Promise<string> => {
  try {
    return await format(html, {
      parser: 'html',
      plugins: [prettierPluginHtml],
      printWidth: 120,
    });
  } catch (error) {
    console.error('Error formatting HTML:', error);
    return html;
  }
};
```

### Integration with Tiptap

This utility is called directly within the `onUpdate` handler of our [`RichEditor.tsx`](apps/web/src/components/editors/RichEditor.tsx:1) component. This ensures that every change made in the Tiptap editor is immediately formatted before the state is updated. See the [Tiptap integration documentation](tiptap.md) for the full data flow.
**Last Updated:** 2025-08-13